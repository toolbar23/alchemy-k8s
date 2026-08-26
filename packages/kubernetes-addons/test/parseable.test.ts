import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import { Parseable, providers } from "../src/index.ts";
import {
  PARSEABLE_CHART_VERSION,
  PARSEABLE_IMAGE,
  parseableHelmValues,
  parseableIngressManifest,
  parseableOtlpEndpoints,
  validateParseableProps,
  type ParseableProps,
} from "../src/parseable.ts";

const acceptsCluster = (_cluster: ParseableProps["cluster"]): void => undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

const storage = {
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "parseable",
  accessKeyId: "parseable-access-key",
  secretAccessKey: Redacted.make("parseable-secret-key"),
  forcePathStyle: true,
};

describe("KubernetesAddons.Parseable", () => {
  it("exports the composite and its complete provider layer", () => {
    expect(Parseable).toBeTypeOf("function");
    expect(providers).toBeTypeOf("function");
  });

  it("pins the chart and image and keeps credentials out of Helm values", () => {
    expect(PARSEABLE_CHART_VERSION).toBe("3.2.1");
    expect(PARSEABLE_IMAGE).toBe("quay.io/parseablehq/parseable:v3.1.0");

    const values = parseableHelmValues({
      releaseName: "parseable",
      secretName: "parseable-env",
      secretResourceVersion: "42",
      forcePathStyle: storage.forcePathStyle,
      staging: { size: "10Gi", storageClass: "hcloud-volumes" },
    });

    expect(values).toMatchObject({
      parseable: {
        fullnameOverride: "parseable",
        deploymentMode: "standalone",
        image: {
          repository: "quay.io/parseablehq/parseable",
          tag: "v3.1.0",
          pullPolicy: "IfNotPresent",
        },
        store: { type: "s3-store", secretName: "parseable-env" },
        standalone: {
          unified: {
            env: {
              P_CHECK_UPDATE: "false",
              P_SEND_ANONYMOUS_USAGE_DATA: "false",
              P_S3_PATH_STYLE: "true",
            },
            persistence: {
              data: { enabled: false },
              staging: {
                enabled: true,
                storageClass: "hcloud-volumes",
                accessMode: "ReadWriteOnce",
                size: "10Gi",
              },
            },
            podAnnotations: {
              "alchemy.run/parseable-secret-resource-version": "42",
            },
          },
        },
      },
    });
    expect(JSON.stringify(values)).not.toContain("parseable-secret-key");
    expect(JSON.stringify(values)).not.toContain("parseable-access-key");
  });

  it("renders only the requested ingress and existing TLS Secret", () => {
    expect(
      parseableIngressManifest("observability", "parseable-service", {
        host: "observe.example.com",
        className: "traefik",
        tlsSecretName: "observe-tls",
      }),
    ).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: "parseable-service",
        namespace: "observability",
      },
      spec: {
        ingressClassName: "traefik",
        tls: [{ hosts: ["observe.example.com"], secretName: "observe-tls" }],
        rules: [
          {
            host: "observe.example.com",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: "parseable-service",
                      port: { number: 80 },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(
      parseableIngressManifest("observability", "parseable-service", {
        host: "observe.example.com",
      }),
    ).not.toHaveProperty("spec.tls");
  });

  it("exposes Axiom-shaped endpoints with Parseable signal headers", () => {
    expect(
      parseableOtlpEndpoints("http://parseable.observability.svc", {
        logs: "application-logs",
        traces: "application-traces",
        metrics: "application-metrics",
      }),
    ).toEqual({
      otelEndpoint: "http://parseable.observability.svc",
      otelTracesEndpoint: "http://parseable.observability.svc/v1/traces",
      otelLogsEndpoint: "http://parseable.observability.svc/v1/logs",
      otelMetricsEndpoint: "http://parseable.observability.svc/v1/metrics",
      endpoints: {
        url: "http://parseable.observability.svc",
        traces: {
          url: "http://parseable.observability.svc/v1/traces",
          headers: {
            "X-P-Stream": "application-traces",
            "X-P-Log-Source": "otel-traces",
          },
        },
        logs: {
          url: "http://parseable.observability.svc/v1/logs",
          headers: {
            "X-P-Stream": "application-logs",
            "X-P-Log-Source": "otel-logs",
          },
        },
        metrics: {
          url: "http://parseable.observability.svc/v1/metrics",
          headers: {
            "X-P-Stream": "application-metrics",
            "X-P-Log-Source": "otel-metrics",
          },
        },
      },
    });
  });

  it("rejects unsupported temporary S3 credentials and unsafe names", () => {
    expect(() =>
      validateParseableProps({
        cluster: {} as never,
        storage: { ...storage, sessionToken: Redacted.make("temporary") },
      }),
    ).toThrow("does not support S3 session tokens");
    expect(() =>
      validateParseableProps({
        cluster: {} as never,
        storage,
        releaseName: "Not-Kubernetes-Safe",
      }),
    ).toThrow("Invalid Parseable release name");
    expect(() =>
      validateParseableProps({
        cluster: {} as never,
        storage,
        ingress: { host: "https://observe.example.com" },
      }),
    ).toThrow("Invalid Parseable ingress host");
    expect(() =>
      validateParseableProps({
        cluster: {} as never,
        storage,
        ingress: {
          host: "observe.example.com",
          tlsSecretName: "Not-A-Secret",
        },
      }),
    ).toThrow("Invalid Parseable TLS Secret name");
    expect(() =>
      validateParseableProps({
        cluster: {} as never,
        storage,
        timeoutSeconds: 0,
      }),
    ).toThrow("timeoutSeconds must be greater than zero");
  });
});
