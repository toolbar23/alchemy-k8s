import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as KubernetesAddons from "alchemy-kubernetes-addons";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { kairosIngressPolicy } from "./ingress-policy.ts";
import {
  inspectCloudflare,
  inspectKairos,
  KAIROS_CONTEXT,
  KAIROS_ENDPOINT,
  KAIROS_KUBECONFIG,
  KAIROS_TUNNEL,
  SMOKE_HOST,
  validatePublicHosts,
} from "./preflight.ts";

// Runs even when invoking Alchemy directly, before state or resources can change.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const email = process.env.ACME_EMAIL ?? "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  throw new Error("ACME_EMAIL must be the exact allowed dashboard login email");
const hosts = validatePublicHosts(
  (process.env.KAIROS_PUBLIC_HOSTS ?? SMOKE_HOST)
    .split(",")
    .map((host) => host.trim()),
);
inspectKairos(hosts);
const smoke = process.env.KAIROS_SMOKE_TEST === "true";
if (smoke && !hosts.includes(SMOKE_HOST))
  throw new Error(
    "The smoke test requires test.openmdta.com in KAIROS_PUBLIC_HOSTS",
  );
const cloudflare = await inspectCloudflare(accountId, token, hosts);
const cluster = {
  ...Kubernetes.KubeConfig({
    path: KAIROS_KUBECONFIG,
    context: KAIROS_CONTEXT,
  }),
  endpoint: KAIROS_ENDPOINT,
};

export default Alchemy.Stack(
  "KairosPlatform",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Kubernetes.providers(),
      KubernetesAddons.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    if ((yield* Alchemy.Stage) !== "kairos")
      throw new Error("KairosPlatform must use --stage kairos");
    const accessPolicy = yield* Cloudflare.Access.Policy("Administrators", {
      name: "Kairos administrators",
      decision: "allow",
      include: [{ email }],
    });
    // Keep protection during smoke-route removal; this does not publish any DNS.
    const smokeAccess = yield* Cloudflare.Access.Application("SmokeAccess", {
      name: "Kairos ingress smoke test",
      type: "self_hosted",
      domain: SMOKE_HOST,
      sessionDuration: "24h",
      allowedIdps: [cloudflare.identityProviderId],
      policies: [accessPolicy],
      autoRedirectToIdentity: true,
    });
    const policy = yield* Kubernetes.Manifest("IngressHostnames", {
      cluster,
      manifest: kairosIngressPolicy(hosts),
    });
    const binding = yield* Kubernetes.Manifest("IngressHostnamesBinding", {
      cluster,
      manifest: {
        apiVersion: "admissionregistration.k8s.io/v1",
        kind: "ValidatingAdmissionPolicyBinding",
        metadata: {
          name: "kairos-cloudflare-hostnames",
          annotations: {
            "alchemy.run/policy-version": Output.map(
              policy.uid,
              (uid) => `${uid}:${JSON.stringify(hosts)}`,
            ),
          },
        },
        spec: { policyName: policy.name, validationActions: ["Deny"] },
      },
    });
    const ingress = yield* KubernetesAddons.CloudflareTunnelIngress("Tunnel", {
      cluster,
      accountId,
      zoneId: cloudflare.zoneId,
      tunnelName: KAIROS_TUNNEL,
      dependsOn: Output.map(binding.uid, (version) => version ?? "created"),
    });
    if (smoke) {
      const namespace = yield* Kubernetes.Manifest("SmokeNamespace", {
        cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: "kairos-ingress-test" },
        },
      });
      const deployment = yield* Kubernetes.Manifest("SmokeDeployment", {
        cluster,
        manifest: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "smoke", namespace: namespace.name },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: "kairos-ingress-test" } },
            template: {
              metadata: { labels: { app: "kairos-ingress-test" } },
              spec: {
                automountServiceAccountToken: false,
                containers: [
                  {
                    name: "http",
                    image: "traefik/whoami:v1.11.0",
                    args: ["--port=8080"],
                    ports: [{ containerPort: 8080 }],
                    readinessProbe: { httpGet: { path: "/", port: 8080 } },
                    resources: {
                      requests: { cpu: "10m", memory: "16Mi" },
                      limits: { memory: "64Mi" },
                    },
                    securityContext: {
                      runAsNonRoot: true,
                      runAsUser: 65532,
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
      const service = yield* Kubernetes.Manifest("SmokeService", {
        cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "smoke", namespace: deployment.namespace },
          spec: {
            selector: { app: "kairos-ingress-test" },
            ports: [{ port: 80, targetPort: 8080 }],
          },
        },
      });
      yield* Kubernetes.Manifest("SmokeIngress", {
        cluster,
        manifest: {
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
          metadata: {
            name: "smoke",
            namespace: service.namespace,
            annotations: {
              "alchemy.run/access-application": smokeAccess.applicationId,
              "alchemy.run/controller-revision": ingress.chart.code.hash,
            },
          },
          spec: {
            ingressClassName: ingress.ingressClassName,
            rules: [
              {
                host: SMOKE_HOST,
                http: {
                  paths: [
                    {
                      path: "/",
                      pathType: "Prefix",
                      backend: {
                        service: { name: service.name, port: { number: 80 } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
    }
    return {
      context: KAIROS_CONTEXT,
      endpoint: KAIROS_ENDPOINT,
      ingressClassName: ingress.ingressClassName,
      accessPolicyId: accessPolicy.policyId,
      smokeUrl: smoke ? `https://${SMOKE_HOST}` : undefined,
    };
  }).pipe(Effect.catchTag("UnknownError", Effect.die)),
);
