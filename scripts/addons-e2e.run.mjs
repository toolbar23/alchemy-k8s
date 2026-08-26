import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Kubernetes from "alchemy/Kubernetes";
import * as KubernetesAddons from "alchemy-kubernetes-addons";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import process from "node:process";

const kubeconfig = process.env.ADDONS_E2E_KUBECONFIG;
const target = process.env.ADDONS_E2E_TARGET;
const canary = process.env.ADDONS_E2E_SECRET;
if (kubeconfig === undefined || target === undefined || canary === undefined) {
  throw new Error(
    "ADDONS_E2E_KUBECONFIG, ADDONS_E2E_TARGET, and ADDONS_E2E_SECRET are required",
  );
}
if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(target)) {
  throw new Error("ADDONS_E2E_TARGET must be a Kubernetes name");
}

const namespaceName = `addons-e2e-${target}`;
const releaseName = `otel-e2e-${target}`;

export default Alchemy.Stack(
  "KubernetesAddonsE2E",
  {
    providers: Layer.mergeAll(
      Kubernetes.providers(),
      KubernetesAddons.providers(),
    ),
    state:
      process.env.ADDONS_E2E_REMOTE_STATE === "true"
        ? Cloudflare.state()
        : Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = Kubernetes.KubeConfig({
      path: kubeconfig,
      ...(process.env.ADDONS_E2E_CONTEXT === undefined
        ? {}
        : { context: process.env.ADDONS_E2E_CONTEXT }),
    });
    const namespace = yield* Kubernetes.Manifest("Namespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });
    const rotationSecret = yield* KubernetesAddons.Secret("RotationSecret", {
      cluster: namespace.connection,
      namespace: namespace.name,
      name: "rotation-canary",
      stringData: { token: Redacted.make(canary) },
    });

    yield* Kubernetes.Manifest("TelemetrySinkDeployment", {
      cluster: namespace.connection,
      manifest: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "telemetry-sink", namespace: namespace.name },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "telemetry-sink" } },
          template: {
            metadata: { labels: { app: "telemetry-sink" } },
            spec: {
              containers: [
                {
                  name: "sink",
                  image: "python:3.13.7-alpine3.22",
                  command: [
                    "python",
                    "-c",
                    "from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_POST(self):\n  self.rfile.read(int(self.headers.get('content-length','0')))\n  print(self.path,flush=True); self.send_response(200); self.end_headers()\n def log_message(self,*args): pass\nHTTPServer(('0.0.0.0',8080),H).serve_forever()",
                  ],
                  ports: [{ name: "http", containerPort: 8080 }],
                  readinessProbe: {
                    tcpSocket: { port: "http" },
                    periodSeconds: 2,
                  },
                  resources: {
                    requests: { cpu: "5m", memory: "16Mi" },
                    limits: { memory: "64Mi" },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                },
              ],
            },
          },
        },
      },
    });
    yield* Kubernetes.Manifest("TelemetrySinkService", {
      cluster: namespace.connection,
      manifest: {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "telemetry-sink", namespace: namespace.name },
        spec: {
          type: "ClusterIP",
          selector: { app: "telemetry-sink" },
          ports: [{ name: "http", port: 8080, targetPort: "http" }],
        },
      },
    });

    const sink = `http://telemetry-sink.${namespaceName}.svc.cluster.local:8080`;
    const header = { "x-alchemy-e2e": Redacted.make(canary) };
    const collector = yield* KubernetesAddons.OtelCollector("Collector", {
      cluster: namespace.connection,
      namespace: namespaceName,
      releaseName,
      createNamespace: false,
      timeoutSeconds: 300,
      destination: {
        endpoints: {
          traces: { url: `${sink}/v1/traces`, headers: header },
          logs: { url: `${sink}/v1/logs`, headers: header },
          metrics: { url: `${sink}/v1/metrics`, headers: header },
        },
      },
    });

    return {
      namespace: namespaceName,
      collectorService: collector.serviceName,
      otelEndpoint: collector.otelEndpoint,
      rotationSecretResourceVersion: rotationSecret.resourceVersion,
    };
  }),
);
