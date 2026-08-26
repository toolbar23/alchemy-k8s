import { makeRandom, type Input } from "alchemy";
import * as Output from "alchemy/Output";
import type * as Telemetry from "alchemy/Telemetry";
import * as Kubernetes from "alchemy/Kubernetes";
import type { S3BucketAccess } from "alchemy-s3-access";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { ReadyHelmChart, Secret } from "./index.ts";

export const PARSEABLE_CHART_VERSION = "3.2.1";
const PARSEABLE_IMAGE_REPOSITORY = "quay.io/parseablehq/parseable";
const PARSEABLE_IMAGE_TAG = "v3.1.0";
export const PARSEABLE_IMAGE = `${PARSEABLE_IMAGE_REPOSITORY}:${PARSEABLE_IMAGE_TAG}`;

export interface ParseableStagingProps {
  /** Persistent staging space for acknowledged data waiting to reach S3. */
  size?: string;
  storageClass?: string;
}

export interface ParseableIngressProps {
  host: string;
  /** Existing ingress class. The add-on does not install an ingress controller. */
  className?: string;
  /** Existing TLS Secret, normally issued by cert-manager. */
  tlsSecretName?: string;
}

export interface ParseableProps {
  cluster: Input<Kubernetes.ClusterLike>;
  storage: S3BucketAccess;
  namespace?: string;
  releaseName?: string;
  admin?: {
    username?: string;
    password?: Redacted.Redacted<string>;
  };
  staging?: ParseableStagingProps;
  streams?: {
    logs?: string;
    traces?: string;
    metrics?: string;
  };
  ingress?: ParseableIngressProps;
  timeoutSeconds?: number;
}

/** Axiom-shaped endpoint names for standard OTEL environment variables. */
export interface ParseableOtlpEndpoints {
  otelEndpoint: string;
  otelTracesEndpoint: string;
  otelLogsEndpoint: string;
  otelMetricsEndpoint: string;
}

export interface ParseableResult extends ParseableOtlpEndpoints {
  namespace: string;
  releaseName: string;
  serviceName: string;
  streams: {
    logs: string;
    traces: string;
    metrics: string;
  };
  internalUrl: string;
  uiUrl: string;
  admin: {
    username: string;
    password: Input<Redacted.Redacted<string>>;
  };
  credentialsSecretRef: {
    namespace: string;
    name: string;
    usernameKey: "username";
    passwordKey: "password";
    resourceVersion: Input<string | undefined>;
  };
  /** Endpoint-only OTLP shape. Authentication is mounted from the Secret by the collector. */
  endpoints: Pick<Telemetry.OtlpOptions, "url" | "traces" | "logs" | "metrics">;
  ingress?: {
    host: string;
    url: string;
    tls: boolean;
  };
}

interface ParseableHelmValuesProps {
  releaseName: string;
  secretName: Input<string>;
  secretResourceVersion: Input<string>;
  forcePathStyle?: boolean | undefined;
  staging: ParseableStagingProps;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const hostname =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const validateParseableProps = (props: ParseableProps): void => {
  const namespace = props.namespace ?? "parseable";
  const releaseName = props.releaseName ?? "parseable";
  if (!kubernetesName.test(namespace) || namespace.length > 63) {
    throw new Error(`Invalid Parseable namespace: ${namespace}`);
  }
  if (!kubernetesName.test(releaseName) || releaseName.length > 44) {
    throw new Error(`Invalid Parseable release name: ${releaseName}`);
  }
  if ((props.admin?.username ?? "admin").trim() === "") {
    throw new Error("Parseable admin username must not be empty");
  }
  if ((props.staging?.size ?? "5Gi").trim() === "") {
    throw new Error("Parseable staging size must not be empty");
  }
  if (
    Object.values({
      logs: props.streams?.logs ?? "otel-logs",
      traces: props.streams?.traces ?? "otel-traces",
      metrics: props.streams?.metrics ?? "otel-metrics",
    }).some((stream) => stream.trim() === "")
  ) {
    throw new Error("Parseable stream names must not be empty");
  }
  if (props.storage.sessionToken !== undefined) {
    throw new Error(
      "Parseable does not support S3 session tokens; use static bucket-scoped credentials",
    );
  }
  if (props.ingress !== undefined && !hostname.test(props.ingress.host)) {
    throw new Error(`Invalid Parseable ingress host: ${props.ingress.host}`);
  }
  if (
    props.ingress?.className !== undefined &&
    !hostname.test(props.ingress.className)
  ) {
    throw new Error(
      `Invalid Parseable ingress class: ${props.ingress.className}`,
    );
  }
  if (
    props.ingress?.tlsSecretName !== undefined &&
    !hostname.test(props.ingress.tlsSecretName)
  ) {
    throw new Error(
      `Invalid Parseable TLS Secret name: ${props.ingress.tlsSecretName}`,
    );
  }
};

export const parseableHelmValues = ({
  releaseName,
  secretName,
  secretResourceVersion,
  forcePathStyle,
  staging,
}: ParseableHelmValuesProps): Record<string, unknown> => ({
  parseable: {
    fullnameOverride: releaseName,
    deploymentMode: "standalone",
    image: {
      repository: PARSEABLE_IMAGE_REPOSITORY,
      tag: PARSEABLE_IMAGE_TAG,
      pullPolicy: "IfNotPresent",
    },
    store: {
      type: "s3-store",
      secretName,
    },
    standalone: {
      unified: {
        env: {
          P_CHECK_UPDATE: "false",
          P_SEND_ANONYMOUS_USAGE_DATA: "false",
          P_S3_PATH_STYLE: String(forcePathStyle ?? false),
        },
        persistence: {
          data: { enabled: false },
          staging: {
            enabled: true,
            storageClass: staging.storageClass ?? "",
            accessMode: "ReadWriteOnce",
            size: staging.size ?? "5Gi",
          },
        },
        podAnnotations: {
          "alchemy.run/parseable-secret-resource-version":
            secretResourceVersion,
        },
      },
    },
  },
});

export const parseableIngressManifest = (
  namespace: string,
  serviceName: string,
  ingress: ParseableIngressProps,
): Kubernetes.KubernetesManifest => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "Ingress",
  metadata: {
    name: serviceName,
    namespace,
  },
  spec: {
    ...(ingress.className === undefined
      ? {}
      : { ingressClassName: ingress.className }),
    ...(ingress.tlsSecretName === undefined
      ? {}
      : {
          tls: [
            {
              hosts: [ingress.host],
              secretName: ingress.tlsSecretName,
            },
          ],
        }),
    rules: [
      {
        host: ingress.host,
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: {
                service: {
                  name: serviceName,
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

export const parseableOtlpEndpoints = (
  internalUrl: string,
  streams: { logs: string; traces: string; metrics: string },
): ParseableOtlpEndpoints & {
  endpoints: Pick<Telemetry.OtlpOptions, "url" | "traces" | "logs" | "metrics">;
} => {
  const otelTracesEndpoint = `${internalUrl}/v1/traces`;
  const otelLogsEndpoint = `${internalUrl}/v1/logs`;
  const otelMetricsEndpoint = `${internalUrl}/v1/metrics`;
  return {
    otelEndpoint: internalUrl,
    otelTracesEndpoint,
    otelLogsEndpoint,
    otelMetricsEndpoint,
    endpoints: {
      url: internalUrl,
      traces: {
        url: otelTracesEndpoint,
        headers: {
          "X-P-Stream": streams.traces,
          "X-P-Log-Source": "otel-traces",
        },
      },
      logs: {
        url: otelLogsEndpoint,
        headers: {
          "X-P-Stream": streams.logs,
          "X-P-Log-Source": "otel-logs",
        },
      },
      metrics: {
        url: otelMetricsEndpoint,
        headers: {
          "X-P-Stream": streams.metrics,
          "X-P-Log-Source": "otel-metrics",
        },
      },
    },
  };
};

/** Deploy Parseable OSS with S3 durability and its bundled web UI. */
export const Parseable = (id: string, props: ParseableProps) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateParseableProps(props));

    const namespaceName = props.namespace ?? "parseable";
    const releaseName = props.releaseName ?? "parseable";
    const serviceName = `${releaseName}-standalone-service`;
    const streams = {
      logs: props.streams?.logs ?? "otel-logs",
      traces: props.streams?.traces ?? "otel-traces",
      metrics: props.streams?.metrics ?? "otel-metrics",
    };
    const username = props.admin?.username ?? "admin";
    const password =
      props.admin?.password ?? (yield* makeRandom(`${id}AdminPassword`));

    const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
      cluster: props.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });

    const secret = yield* Secret(`${id}Credentials`, {
      cluster: props.cluster,
      namespace: namespace.name,
      name: `${releaseName}-env`,
      stringData: {
        addr: "0.0.0.0:8000",
        username,
        password,
        "s3.url": props.storage.endpoint,
        "s3.access.key": props.storage.accessKeyId,
        "s3.secret.key": props.storage.secretAccessKey,
        "s3.bucket": props.storage.bucket,
        "s3.region": props.storage.region,
      },
    });

    const chart = yield* ReadyHelmChart(`${id}Chart`, {
      cluster: props.cluster,
      chart: "parseable",
      repo: "https://charts.parseable.com",
      version: PARSEABLE_CHART_VERSION,
      releaseName,
      namespace: namespaceName,
      createNamespace: false,
      timeoutSeconds: props.timeoutSeconds ?? 300,
      values: parseableHelmValues({
        releaseName,
        secretName: secret.name,
        secretResourceVersion: Output.map(
          secret.resourceVersion,
          (resourceVersion) => resourceVersion ?? "unknown",
        ),
        forcePathStyle: props.storage.forcePathStyle,
        staging: props.staging ?? {},
      }),
    });

    if (props.ingress !== undefined) {
      yield* Kubernetes.Manifest(`${id}Ingress`, {
        cluster: chart.connection,
        manifest: parseableIngressManifest(
          namespaceName,
          serviceName,
          props.ingress,
        ),
      });
    }

    const internalUrl = `http://${serviceName}.${namespaceName}.svc.cluster.local`;
    const uiUrl =
      props.ingress === undefined
        ? internalUrl
        : `${props.ingress.tlsSecretName === undefined ? "http" : "https"}://${props.ingress.host}`;
    const otlp = parseableOtlpEndpoints(internalUrl, streams);

    return {
      namespace: namespaceName,
      releaseName,
      serviceName,
      streams,
      internalUrl,
      uiUrl,
      otelEndpoint: otlp.otelEndpoint,
      otelTracesEndpoint: otlp.otelTracesEndpoint,
      otelLogsEndpoint: otlp.otelLogsEndpoint,
      otelMetricsEndpoint: otlp.otelMetricsEndpoint,
      admin: { username, password },
      credentialsSecretRef: {
        namespace: namespaceName,
        name: `${releaseName}-env`,
        usernameKey: "username",
        passwordKey: "password",
        resourceVersion: secret.resourceVersion,
      },
      endpoints: otlp.endpoints,
      ...(props.ingress === undefined
        ? {}
        : {
            ingress: {
              host: props.ingress.host,
              url: uiUrl,
              tls: props.ingress.tlsSecretName !== undefined,
            },
          }),
    } satisfies ParseableResult;
  });
