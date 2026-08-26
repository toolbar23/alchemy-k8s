import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import {
  OTEL_COLLECTOR_CHART_VERSION,
  OTEL_COLLECTOR_IMAGE,
  otelCollectorEndpoints,
  planOtelCollector,
  validateOtelCollectorProps,
  type OtelCollectorProps,
} from "../src/otel-collector.ts";

const acceptsCluster = (_cluster: OtelCollectorProps["cluster"]): void =>
  undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

const parseableDestination = {
  endpoints: {
    traces: {
      url: "http://parseable/v1/traces",
      headers: {
        "X-P-Stream": "otel-traces",
        "X-P-Log-Source": "otel-traces",
      },
    },
    logs: {
      url: "http://parseable/v1/logs",
      headers: {
        "X-P-Stream": "otel-logs",
        "X-P-Log-Source": "otel-logs",
      },
    },
  },
  authentication: {
    type: "basic" as const,
    secretRef: {
      namespace: "parseable",
      name: "parseable-env",
      usernameKey: "username",
      passwordKey: "password",
      resourceVersion: "42",
    },
  },
};

describe("KubernetesAddons.OtelCollector", () => {
  it("pins a minimal HTTP-only collector and composes Basic auth", () => {
    expect(OTEL_COLLECTOR_CHART_VERSION).toBe("0.171.0");
    expect(OTEL_COLLECTOR_IMAGE).toBe(
      "otel/opentelemetry-collector-contrib@sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5",
    );

    const plan = planOtelCollector({
      releaseName: "otel-collector",
      destination: parseableDestination,
      namespaceRevision: "external",
      headerSecretName: "otel-collector-headers",
      headerSecretRevision: "7",
      basicSecretRevision: "42",
    });

    expect(plan.signals).toEqual(["traces", "logs"]);
    expect(plan.values).toMatchObject({
      fullnameOverride: "otel-collector",
      mode: "deployment",
      replicaCount: 1,
      image: {
        repository: "otel/opentelemetry-collector-contrib",
        tag: "0.158.0",
        digest:
          "sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5",
        pullPolicy: "IfNotPresent",
      },
      command: { name: "otelcol-contrib" },
      alternateConfig: {
        extensions: {
          health_check: { endpoint: "${env:MY_POD_IP}:13133" },
          "basicauth/destination": {
            client_auth: {
              username: "${env:OTEL_DESTINATION_USERNAME}",
              password: "${env:OTEL_DESTINATION_PASSWORD}",
            },
          },
        },
        receivers: {
          otlp: {
            protocols: {
              http: { endpoint: "${env:MY_POD_IP}:4318" },
            },
          },
        },
        exporters: {
          "otlp_http/traces": {
            traces_endpoint: "http://parseable/v1/traces",
            encoding: "json",
            auth: { authenticator: "basicauth/destination" },
          },
          "otlp_http/logs": {
            logs_endpoint: "http://parseable/v1/logs",
            encoding: "json",
            auth: { authenticator: "basicauth/destination" },
          },
        },
        service: {
          extensions: ["health_check", "basicauth/destination"],
          pipelines: {
            traces: {
              receivers: ["otlp"],
              processors: ["memory_limiter", "batch"],
              exporters: ["otlp_http/traces"],
            },
            logs: {
              receivers: ["otlp"],
              processors: ["memory_limiter", "batch"],
              exporters: ["otlp_http/logs"],
            },
          },
        },
      },
      ports: {
        otlp: { enabled: false },
        "otlp-http": {
          enabled: true,
          containerPort: 4318,
          servicePort: 4318,
          hostPort: null,
          protocol: "TCP",
        },
        "jaeger-compact": { enabled: false },
        "jaeger-thrift": { enabled: false },
        "jaeger-grpc": { enabled: false },
        zipkin: { enabled: false },
        metrics: { enabled: false },
      },
      service: { type: "ClusterIP" },
      ingress: { enabled: false },
      serviceAccount: {
        create: true,
        automountServiceAccountToken: false,
      },
      clusterRole: { create: false },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      podAnnotations: {
        "alchemy.run/namespace-revision": "external",
        "alchemy.run/header-secret-revision": "7",
        "alchemy.run/basic-secret-revision": "42",
      },
    });

    expect(plan.values).not.toHaveProperty(
      "alternateConfig.receivers.otlp.protocols.grpc",
    );
    expect(JSON.stringify(plan.values)).not.toContain("password-value");
  });

  it("stores every destination header in a Secret and never Helm values", () => {
    const canary = "collector-secret-canary";
    const plan = planOtelCollector({
      releaseName: "otel-collector",
      destination: {
        endpoints: {
          logs: {
            url: "https://example.com/v1/logs",
            headers: {
              "x-api-key": Redacted.make(canary),
              "x-tenant": "production",
            },
          },
        },
      },
      namespaceRevision: "created",
      headerSecretName: "otel-collector-headers",
    });

    expect(plan.headerSecretData).toMatchObject({
      "logs-0": Redacted.make(canary),
      "logs-1": "production",
    });
    expect(plan.values).toMatchObject({
      extraEnvs: [
        {
          name: "OTEL_DESTINATION_LOGS_HEADER_0",
          valueFrom: {
            secretKeyRef: {
              name: "otel-collector-headers",
              key: "logs-0",
            },
          },
        },
        {
          name: "OTEL_DESTINATION_LOGS_HEADER_1",
          valueFrom: {
            secretKeyRef: {
              name: "otel-collector-headers",
              key: "logs-1",
            },
          },
        },
      ],
      alternateConfig: {
        exporters: {
          "otlp_http/logs": {
            headers: {
              "x-api-key": "${env:OTEL_DESTINATION_LOGS_HEADER_0}",
              "x-tenant": "${env:OTEL_DESTINATION_LOGS_HEADER_1}",
            },
          },
        },
      },
    });
    expect(JSON.stringify(plan.values)).not.toContain(canary);
    expect(JSON.stringify(plan.values)).not.toContain("production");
  });

  it("builds only requested pipelines and expands a base destination", () => {
    const tracesOnly = planOtelCollector({
      releaseName: "collector",
      destination: {
        endpoints: { traces: { url: "https://example.com/v1/traces" } },
      },
      namespaceRevision: "created",
      headerSecretName: "collector-headers",
    });
    expect(tracesOnly.signals).toEqual(["traces"]);
    expect(tracesOnly.values).not.toHaveProperty(
      "alternateConfig.service.pipelines.logs",
    );
    expect(tracesOnly.values).not.toHaveProperty(
      "alternateConfig.service.pipelines.metrics",
    );

    const allSignals = planOtelCollector({
      releaseName: "collector",
      destination: { endpoints: { url: "https://example.com" } },
      namespaceRevision: "created",
      headerSecretName: "collector-headers",
    });
    expect(allSignals.signals).toEqual(["traces", "logs", "metrics"]);
    expect(allSignals.values).toMatchObject({
      alternateConfig: {
        exporters: {
          "otlp_http/traces": { endpoint: "https://example.com" },
          "otlp_http/logs": { endpoint: "https://example.com" },
          "otlp_http/metrics": { endpoint: "https://example.com" },
        },
      },
    });
  });

  it("returns standard in-cluster OTLP endpoints", () => {
    expect(otelCollectorEndpoints("collector", "observability")).toEqual({
      otelEndpoint: "http://collector.observability.svc.cluster.local:4318",
      otelTracesEndpoint:
        "http://collector.observability.svc.cluster.local:4318/v1/traces",
      otelLogsEndpoint:
        "http://collector.observability.svc.cluster.local:4318/v1/logs",
      otelMetricsEndpoint:
        "http://collector.observability.svc.cluster.local:4318/v1/metrics",
      otlp: {
        url: "http://collector.observability.svc.cluster.local:4318",
      },
    });
  });

  it("rejects invalid ownership and authentication combinations", () => {
    expect(() =>
      validateOtelCollectorProps({
        cluster: {} as never,
        namespace: "other",
        destination: parseableDestination,
      }),
    ).toThrow("must use the same namespace");
    expect(() =>
      validateOtelCollectorProps({
        cluster: {} as never,
        createNamespace: true,
        destination: parseableDestination,
      }),
    ).toThrow("cannot own a namespace");
    expect(() =>
      validateOtelCollectorProps({
        cluster: {} as never,
        destination: parseableDestination,
        timeoutSeconds: 0,
      }),
    ).toThrow("timeoutSeconds must be greater than zero");
    expect(() =>
      validateOtelCollectorProps({
        cluster: {} as never,
        destination: { endpoints: {} },
      }),
    ).toThrow("at least one signal");
    expect(() =>
      validateOtelCollectorProps({
        cluster: {} as never,
        destination: {
          ...parseableDestination,
          endpoints: {
            logs: {
              url: "http://parseable/v1/logs",
              headers: { Authorization: "already-set" },
            },
          },
        },
      }),
    ).toThrow("cannot override Basic authentication");
  });
});
