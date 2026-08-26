import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Hetzner from "alchemy/Hetzner";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HetznerK3s from "alchemy-hetzner-k3s";
import * as KubernetesAddons from "alchemy-kubernetes-addons";

export default Alchemy.Stack(
  "HetznerPlatformExample",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Kubernetes.providers(),
      KubernetesAddons.providers(),
      Hetzner.providers(),
      HetznerK3s.providers(),
    ),
    // The Cloudflare state store encrypts resource state before persisting it.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const domain = yield* Config.string("PUBLIC_DOMAIN");
    const appHost = `api.${domain}`;
    const acmeEmail = yield* Config.string("ACME_EMAIL");
    const enableOtel = yield* Config.boolean("ENABLE_OTEL").pipe(
      Config.withDefault(true),
    );
    const exposeObservability = yield* Config.boolean(
      "ENABLE_OBSERVABILITY_INGRESS",
    ).pipe(Config.withDefault(false));

    const cluster = yield* HetznerK3s.Cluster("Production", {
      k3s: {
        channel: "v1.35",
        updateWindow: {
          days: ["Sunday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "Europe/Berlin",
        },
      },
      controlPlane: {
        count: 3,
        serverType: "cpx22",
        locations: ["nbg1", "fsn1", "hel1"],
      },
      workerPools: [
        {
          name: "general",
          count: 3,
          serverType: "cpx32",
          location: "nbg1",
        },
      ],
      ssh: { allowedCidrs: [yield* Config.string("ADMIN_CIDR")] },
      protectAgainstDeletion: true,
    });

    const zone = yield* Cloudflare.Zone.Zone("PublicZone", {
      name: domain,
    }).pipe(adopt(true));
    yield* KubernetesAddons.CloudflareExternalDns("PublicDns", {
      cluster,
      zone,
      policy: "sync",
      proxied: false,
    });

    const certManager = yield* KubernetesAddons.CertManager("Certificates", {
      cluster,
    });
    const issuer = yield* KubernetesAddons.CloudflareAcmeIssuer("LetsEncrypt", {
      cluster,
      certManager,
      zone,
      email: acmeEmail,
      // Prove the stack with staging before changing this to production.
      environment: "staging",
    });

    let observabilityIngress:
      { host: string; className: string; tlsSecretName: string } | undefined;
    if (exposeObservability) {
      const host = `observe.${domain}`;
      const namespace = yield* Kubernetes.Manifest(
        "ObservabilityCertificateNamespace",
        {
          cluster,
          manifest: {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: "observability" },
          },
        },
      );
      yield* Kubernetes.Manifest("ObservabilityCertificate", {
        cluster,
        manifest: {
          apiVersion: "cert-manager.io/v1",
          kind: "Certificate",
          metadata: { name: "observability-tls", namespace: namespace.name },
          spec: {
            secretName: "observability-tls",
            dnsNames: [host],
            issuerRef: issuer.issuerRef,
          },
        },
      });
      observabilityIngress = {
        host,
        className: "traefik",
        tlsSecretName: "observability-tls",
      };
    }

    const parseable = yield* KubernetesAddons.Parseable("Observability", {
      cluster,
      namespace: "observability",
      storage: {
        endpoint: yield* Config.string("S3_ENDPOINT"),
        region: yield* Config.string("S3_REGION"),
        bucket: yield* Config.string("S3_BUCKET"),
        accessKeyId: yield* Config.string("S3_ACCESS_KEY_ID"),
        secretAccessKey: yield* Config.redacted("S3_SECRET_ACCESS_KEY"),
        forcePathStyle: yield* Config.boolean("S3_FORCE_PATH_STYLE").pipe(
          Config.withDefault(false),
        ),
      },
      admin: {
        password: yield* Config.redacted("PARSEABLE_ADMIN_PASSWORD"),
      },
      staging: { size: "5Gi", storageClass: "hcloud-volumes" },
      ...(observabilityIngress === undefined
        ? {}
        : { ingress: observabilityIngress }),
    });
    const collector = enableOtel
      ? yield* KubernetesAddons.OtelCollector("TelemetryGateway", {
          cluster,
          destination: {
            endpoints: parseable.endpoints,
            authentication: {
              type: "basic",
              secretRef: parseable.credentialsSecretRef,
            },
          },
        })
      : undefined;

    const appNamespace = yield* Kubernetes.Manifest("AppNamespace", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: "api" },
      },
    });
    yield* Kubernetes.Manifest("AppDeployment", {
      cluster,
      manifest: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "api", namespace: appNamespace.name },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: "api" } },
          template: {
            metadata: { labels: { app: "api" } },
            spec: {
              securityContext: {
                runAsNonRoot: true,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [
                {
                  name: "api",
                  image: "registry.k8s.io/e2e-test-images/agnhost:2.53",
                  args: ["netexec", "--http-port=8080"],
                  ports: [{ name: "http", containerPort: 8080 }],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                  env:
                    collector === undefined
                      ? []
                      : [
                          {
                            name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                            value: collector.otelTracesEndpoint,
                          },
                          {
                            name: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
                            value: collector.otelLogsEndpoint,
                          },
                        ],
                  readinessProbe: {
                    httpGet: { path: "/healthz", port: "http" },
                    initialDelaySeconds: 2,
                    periodSeconds: 5,
                  },
                  resources: {
                    requests: { cpu: "10m", memory: "32Mi" },
                    limits: { memory: "128Mi" },
                  },
                },
              ],
            },
          },
        },
      },
    });
    yield* Kubernetes.Manifest("AppService", {
      cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "api", namespace: appNamespace.name },
        spec: {
          type: "ClusterIP",
          selector: { app: "api" },
          ports: [{ name: "http", port: 80, targetPort: "http" }],
        },
      },
    });
    yield* Kubernetes.Manifest("AppCertificate", {
      cluster,
      manifest: {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: "api-tls", namespace: appNamespace.name },
        spec: {
          secretName: "api-tls",
          dnsNames: [appHost],
          issuerRef: issuer.issuerRef,
        },
      },
    });
    yield* Kubernetes.Manifest("AppIngress", {
      cluster,
      manifest: {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { name: "api", namespace: appNamespace.name },
        spec: {
          ingressClassName: "traefik",
          tls: [{ hosts: [appHost], secretName: "api-tls" }],
          rules: [
            {
              host: appHost,
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: {
                      service: { name: "api", port: { name: "http" } },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    return {
      clusterEndpoint: cluster.endpoint,
      appUrl: `https://${appHost}`,
      observabilityUrl: parseable.uiUrl,
      otelEndpoint: collector?.otelEndpoint,
    };
  }).pipe(Effect.catchTag("UnknownError", Effect.die)),
);
