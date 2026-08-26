import { readFileSync } from "node:fs";
import process from "node:process";
import * as Alchemy from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as KubernetesAddons from "alchemy-kubernetes-addons";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const boolean = (name, fallback = false) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
};

const stage = required("REGISTRY_E2E_STAGE");
const namespaceName = `registry-e2e-${stage}`;
const applicationNamespaceName = `registry-e2e-app-${stage}`;
const releaseName = `registry-${stage}`;
const pullSecretName = `${releaseName}-pull`;
const host = required("REGISTRY_E2E_HOST");
const username = required("REGISTRY_E2E_USERNAME");
const password = Redacted.make(required("REGISTRY_E2E_PASSWORD"));
const tlsCertificate = readFileSync(
  required("REGISTRY_E2E_TLS_CERT_FILE"),
  "utf8",
);
const tlsPrivateKey = Redacted.make(
  readFileSync(required("REGISTRY_E2E_TLS_KEY_FILE"), "utf8"),
);
const currentHour = new Date().getUTCHours();
const gcWindow = `${String((currentHour + 23) % 24).padStart(2, "0")}:00-${String(
  (currentHour + 2) % 24,
).padStart(2, "0")}:00`;

export default Alchemy.Stack(
  "ContainerRegistryE2E",
  {
    providers: Layer.mergeAll(
      Kubernetes.providers(),
      KubernetesAddons.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = Kubernetes.KubeConfig({
      path: required("REGISTRY_E2E_KUBECONFIG"),
      ...(process.env.REGISTRY_E2E_CONTEXT === undefined
        ? {}
        : { context: process.env.REGISTRY_E2E_CONTEXT }),
    });
    const registryNamespace = yield* Kubernetes.Manifest("RegistryNamespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });
    const applicationNamespace = yield* Kubernetes.Manifest(
      "ApplicationNamespace",
      {
        cluster: registryNamespace.connection,
        manifest: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: applicationNamespaceName },
        },
      },
    );
    const tlsSecret = yield* KubernetesAddons.Secret("RegistryTls", {
      cluster: applicationNamespace.connection,
      namespace: registryNamespace.name,
      name: `${releaseName}-tls`,
      type: "kubernetes.io/tls",
      stringData: {
        "tls.crt": Redacted.make(tlsCertificate),
        "tls.key": tlsPrivateKey,
      },
    });

    const registry = yield* KubernetesAddons.ContainerRegistry("Registry", {
      cluster: tlsSecret.connection,
      namespace: namespaceName,
      releaseName,
      createNamespace: false,
      storagePrefix: `registry-e2e/${stage}`,
      storage: {
        endpoint: required("REGISTRY_E2E_S3_ENDPOINT"),
        region: required("REGISTRY_E2E_S3_REGION"),
        bucket: required("REGISTRY_E2E_S3_BUCKET"),
        accessKeyId: required("REGISTRY_E2E_S3_ACCESS_KEY_ID"),
        secretAccessKey: Redacted.make(
          required("REGISTRY_E2E_S3_SECRET_ACCESS_KEY"),
        ),
        ...(process.env.REGISTRY_E2E_S3_SESSION_TOKEN === undefined
          ? {}
          : {
              sessionToken: Redacted.make(
                process.env.REGISTRY_E2E_S3_SESSION_TOKEN,
              ),
            }),
        forcePathStyle: boolean("REGISTRY_E2E_S3_FORCE_PATH_STYLE", false),
      },
      credentials: { username, password },
      ingress: {
        host,
        className: process.env.REGISTRY_E2E_INGRESS_CLASS ?? "traefik",
        tlsSecretName: tlsSecret.name,
      },
      pullSecrets: {
        namespaces: [applicationNamespaceName],
        name: pullSecretName,
      },
      garbageCollection: {
        interval: "30s",
        delay: "30s",
        timeWindowUtc: gcWindow,
      },
      timeoutSeconds: 300,
    });
    const pullSecret = registry.pullSecretRefs[0];
    if (pullSecret === undefined) {
      return yield* Effect.die(
        new Error(
          "Container registry did not create the requested pull Secret",
        ),
      );
    }

    yield* Kubernetes.Manifest("RegistryPullWorkload", {
      cluster: tlsSecret.connection,
      manifest: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "registry-pull",
          namespace: applicationNamespaceName,
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "registry-pull" } },
          template: {
            metadata: {
              labels: { app: "registry-pull" },
              annotations: {
                "alchemy.run/pull-secret-revision": pullSecret.resourceVersion,
              },
            },
            spec: {
              securityContext: {
                runAsNonRoot: true,
                seccompProfile: { type: "RuntimeDefault" },
              },
              imagePullSecrets: [{ name: pullSecret.name }],
              containers: [
                {
                  name: "fixture",
                  image: `${registry.imagePrefix}/alchemy/e2e:latest`,
                  imagePullPolicy: "Always",
                  command: ["sh", "-c", "echo registry-pull-ok; sleep 3600"],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    runAsNonRoot: true,
                    runAsUser: 65532,
                    capabilities: { drop: ["ALL"] },
                  },
                  resources: {
                    requests: { cpu: "5m", memory: "8Mi" },
                    limits: { memory: "32Mi" },
                  },
                },
              ],
            },
          },
        },
      },
    });

    return {
      namespace: registry.namespace,
      applicationNamespace: applicationNamespaceName,
      releaseName: registry.releaseName,
      host: registry.host,
      url: registry.url,
      image: `${registry.imagePrefix}/alchemy/e2e:latest`,
      pullSecretName,
    };
  }),
);
