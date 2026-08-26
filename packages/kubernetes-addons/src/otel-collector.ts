import type { Input } from "alchemy";
import * as Output from "alchemy/Output";
import type * as Telemetry from "alchemy/Telemetry";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { ReadyHelmChart, Secret } from "./index.ts";

export const OTEL_COLLECTOR_CHART_VERSION = "0.171.0";
const OTEL_COLLECTOR_IMAGE_REPOSITORY = "otel/opentelemetry-collector-contrib";
const OTEL_COLLECTOR_IMAGE_TAG = "0.158.0";
const OTEL_COLLECTOR_IMAGE_DIGEST =
  "sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5";
export const OTEL_COLLECTOR_IMAGE = `${OTEL_COLLECTOR_IMAGE_REPOSITORY}@${OTEL_COLLECTOR_IMAGE_DIGEST}`;

export type OtelSignal = "traces" | "logs" | "metrics";

export interface OtelCollectorBasicAuthSecretRef {
  namespace: string;
  name: string;
  usernameKey: string;
  passwordKey: string;
  /** Changes to this non-secret value force pods to reload Secret-backed env. */
  resourceVersion: Input<string | undefined>;
}

export interface OtelCollectorDestination {
  endpoints: Telemetry.OtlpOptions;
  encoding?: "json" | "proto";
  authentication?: {
    type: "basic";
    secretRef: OtelCollectorBasicAuthSecretRef;
  };
}

export interface OtelCollectorProps {
  cluster: Input<Kubernetes.ClusterLike>;
  destination: OtelCollectorDestination;
  namespace?: string;
  releaseName?: string;
  /** Own a new namespace. Defaults off when authentication references a Secret. */
  createNamespace?: boolean;
  timeoutSeconds?: number;
}

export interface OtelCollectorResult {
  namespace: string;
  releaseName: string;
  serviceName: string;
  signals: OtelSignal[];
  otelEndpoint: string;
  otelTracesEndpoint: string;
  otelLogsEndpoint: string;
  otelMetricsEndpoint: string;
  otlp: Telemetry.OtlpOptions;
}

interface HeaderBinding {
  signal: OtelSignal;
  name: string;
  envName: string;
  secretKey: string;
  value: Telemetry.OtlpHeaderValue;
}

interface OtelCollectorPlanProps {
  releaseName: string;
  destination: OtelCollectorDestination;
  namespaceRevision: Input<string>;
  headerSecretName: string;
  headerSecretRevision?: Input<string> | undefined;
  basicSecretRevision?: Input<string | undefined> | undefined;
}

export interface OtelCollectorPlan {
  signals: OtelSignal[];
  headerSecretData: Record<
    string,
    | string
    | Redacted.Redacted<string>
    | Input<string | Redacted.Redacted<string>>
  >;
  values: Record<string, unknown>;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const httpHeaderName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const signals = ["traces", "logs", "metrics"] as const;

export const validateOtelCollectorProps = (props: OtelCollectorProps): void => {
  const authenticationNamespace =
    props.destination.authentication?.secretRef.namespace;
  const namespace =
    props.namespace ?? authenticationNamespace ?? "otel-collector";
  const releaseName = props.releaseName ?? "otel-collector";
  const createNamespace =
    props.createNamespace ?? authenticationNamespace === undefined;

  if (!kubernetesName.test(namespace) || namespace.length > 63) {
    throw new Error(`Invalid OTEL collector namespace: ${namespace}`);
  }
  if (!kubernetesName.test(releaseName) || releaseName.length > 55) {
    throw new Error(`Invalid OTEL collector release name: ${releaseName}`);
  }
  if (
    authenticationNamespace !== undefined &&
    namespace !== authenticationNamespace
  ) {
    throw new Error(
      "OTEL collector and its authentication Secret must use the same namespace",
    );
  }
  if (authenticationNamespace !== undefined && createNamespace) {
    throw new Error(
      "OTEL collector cannot own a namespace that already contains its authentication Secret",
    );
  }
  if (
    props.timeoutSeconds !== undefined &&
    (!Number.isFinite(props.timeoutSeconds) || props.timeoutSeconds <= 0)
  ) {
    throw new Error("OTEL collector timeoutSeconds must be greater than zero");
  }

  const endpoints = props.destination.endpoints;
  if (
    endpoints.url === undefined &&
    endpoints.traces === undefined &&
    endpoints.logs === undefined &&
    endpoints.metrics === undefined
  ) {
    throw new Error(
      "OTEL collector destination must configure at least one signal",
    );
  }

  for (const signal of signals) {
    const signalOptions = endpoints[signal];
    if (
      typeof signalOptions?.url === "string" &&
      signalOptions.url.trim() === ""
    ) {
      throw new Error(`OTEL collector ${signal} endpoint must not be empty`);
    }
    const headers = signalOptions?.headers ?? endpoints.headers ?? {};
    const lowerNames = new Set<string>();
    for (const name of Object.keys(headers)) {
      if (!httpHeaderName.test(name)) {
        throw new Error(`Invalid OTEL ${signal} header name: ${name}`);
      }
      const lowerName = name.toLowerCase();
      if (lowerNames.has(lowerName)) {
        throw new Error(`Duplicate OTEL ${signal} header name: ${name}`);
      }
      lowerNames.add(lowerName);
      if (
        lowerName === "authorization" &&
        props.destination.authentication?.type === "basic"
      ) {
        throw new Error(
          `OTEL ${signal} headers cannot override Basic authentication`,
        );
      }
    }
  }
};

export const planOtelCollector = ({
  releaseName,
  destination,
  namespaceRevision,
  headerSecretName,
  headerSecretRevision,
  basicSecretRevision,
}: OtelCollectorPlanProps): OtelCollectorPlan => {
  const hasBase = destination.endpoints.url !== undefined;
  const enabledSignals = signals.filter(
    (signal) => hasBase || destination.endpoints[signal] !== undefined,
  );
  const headerBindings: HeaderBinding[] = [];
  for (const signal of enabledSignals) {
    const signalOptions = destination.endpoints[signal];
    const headers =
      signalOptions?.headers ?? destination.endpoints.headers ?? {};
    for (const [index, [name, value]] of Object.entries(headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .entries()) {
      headerBindings.push({
        signal,
        name,
        value,
        secretKey: `${signal}-${String(index)}`,
        envName: `OTEL_DESTINATION_${signal.toUpperCase()}_HEADER_${String(index)}`,
      });
    }
  }

  const basic = destination.authentication;
  const exporters: Record<string, unknown> = {};
  const pipelines: Record<string, unknown> = {};
  for (const signal of enabledSignals) {
    const signalOptions = destination.endpoints[signal];
    const exporterName = `otlp_http/${signal}`;
    const headers = Object.fromEntries(
      headerBindings
        .filter((binding) => binding.signal === signal)
        .map((binding) => [binding.name, "${env:" + binding.envName + "}"]),
    );
    exporters[exporterName] = {
      ...(signalOptions === undefined
        ? { endpoint: destination.endpoints.url }
        : { [`${signal}_endpoint`]: signalOptions.url }),
      encoding: destination.encoding ?? "json",
      compression: "gzip",
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(basic === undefined
        ? {}
        : { auth: { authenticator: "basicauth/destination" } }),
      retry_on_failure: {
        enabled: true,
        initial_interval: "1s",
        max_interval: "30s",
        max_elapsed_time: "0s",
      },
      sending_queue: {
        enabled: true,
        num_consumers: 4,
        queue_size: 10000,
      },
    };
    pipelines[signal] = {
      receivers: ["otlp"],
      processors: ["memory_limiter", "batch"],
      exporters: [exporterName],
    };
  }

  const extensions: Record<string, unknown> = {
    health_check: { endpoint: "${env:MY_POD_IP}:13133" },
  };
  if (basic !== undefined) {
    extensions["basicauth/destination"] = {
      client_auth: {
        username: "${env:OTEL_DESTINATION_USERNAME}",
        password: "${env:OTEL_DESTINATION_PASSWORD}",
      },
    };
  }

  const extraEnvs = headerBindings.map((binding) => ({
    name: binding.envName,
    valueFrom: {
      secretKeyRef: { name: headerSecretName, key: binding.secretKey },
    },
  }));
  if (basic !== undefined) {
    extraEnvs.push(
      {
        name: "OTEL_DESTINATION_USERNAME",
        valueFrom: {
          secretKeyRef: {
            name: basic.secretRef.name,
            key: basic.secretRef.usernameKey,
          },
        },
      },
      {
        name: "OTEL_DESTINATION_PASSWORD",
        valueFrom: {
          secretKeyRef: {
            name: basic.secretRef.name,
            key: basic.secretRef.passwordKey,
          },
        },
      },
    );
  }

  return {
    signals: [...enabledSignals],
    headerSecretData: Object.fromEntries(
      headerBindings.map((binding) => [binding.secretKey, binding.value]),
    ),
    values: {
      fullnameOverride: releaseName,
      mode: "deployment",
      replicaCount: 1,
      image: {
        repository: OTEL_COLLECTOR_IMAGE_REPOSITORY,
        tag: OTEL_COLLECTOR_IMAGE_TAG,
        digest: OTEL_COLLECTOR_IMAGE_DIGEST,
        pullPolicy: "IfNotPresent",
      },
      command: { name: "otelcol-contrib" },
      alternateConfig: {
        extensions,
        receivers: {
          otlp: {
            protocols: {
              http: { endpoint: "${env:MY_POD_IP}:4318" },
            },
          },
        },
        processors: {
          memory_limiter: {
            check_interval: "1s",
            limit_percentage: 75,
            spike_limit_percentage: 15,
          },
          batch: {},
        },
        exporters,
        service: {
          extensions: Object.keys(extensions),
          pipelines,
          telemetry: { logs: { level: "info" } },
        },
      },
      extraEnvs,
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
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { memory: "512Mi" },
      },
      podSecurityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      podAnnotations: {
        "alchemy.run/namespace-revision": namespaceRevision,
        ...(headerSecretRevision === undefined
          ? {}
          : { "alchemy.run/header-secret-revision": headerSecretRevision }),
        ...(basicSecretRevision === undefined
          ? {}
          : { "alchemy.run/basic-secret-revision": basicSecretRevision }),
      },
    },
  };
};

export const otelCollectorEndpoints = (
  serviceName: string,
  namespace: string,
): Pick<
  OtelCollectorResult,
  | "otelEndpoint"
  | "otelTracesEndpoint"
  | "otelLogsEndpoint"
  | "otelMetricsEndpoint"
  | "otlp"
> => {
  const otelEndpoint = `http://${serviceName}.${namespace}.svc.cluster.local:4318`;
  return {
    otelEndpoint,
    otelTracesEndpoint: `${otelEndpoint}/v1/traces`,
    otelLogsEndpoint: `${otelEndpoint}/v1/logs`,
    otelMetricsEndpoint: `${otelEndpoint}/v1/metrics`,
    otlp: { url: otelEndpoint },
  };
};

/** Deploy a minimal OTLP/HTTP gateway for one downstream destination. */
export const OtelCollector = (id: string, props: OtelCollectorProps) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateOtelCollectorProps(props));

    const authenticationNamespace =
      props.destination.authentication?.secretRef.namespace;
    const namespaceName =
      props.namespace ?? authenticationNamespace ?? "otel-collector";
    const releaseName = props.releaseName ?? "otel-collector";
    const createNamespace =
      props.createNamespace ?? authenticationNamespace === undefined;

    let namespaceRevision: Input<string> = "external";
    let secretNamespace: Input<string> = namespaceName;
    if (createNamespace) {
      const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
        cluster: props.cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespaceName },
        },
      });
      namespaceRevision = Output.map(namespace.uid, (uid) => uid ?? "created");
      secretNamespace = namespace.name;
    }

    const preliminary = planOtelCollector({
      releaseName,
      destination: props.destination,
      namespaceRevision,
      headerSecretName: `${releaseName}-headers`,
    });

    let headerSecretRevision: Input<string> | undefined;
    if (Object.keys(preliminary.headerSecretData).length > 0) {
      const headerSecret = yield* Secret(`${id}Headers`, {
        cluster: props.cluster,
        namespace: secretNamespace,
        name: `${releaseName}-headers`,
        stringData: preliminary.headerSecretData,
      });
      headerSecretRevision = Output.map(
        headerSecret.resourceVersion,
        (resourceVersion) => resourceVersion ?? "unknown",
      );
    }

    const basicSecretRevision =
      props.destination.authentication?.secretRef.resourceVersion;
    const plan = planOtelCollector({
      releaseName,
      destination: props.destination,
      namespaceRevision,
      headerSecretName: `${releaseName}-headers`,
      headerSecretRevision,
      basicSecretRevision,
    });

    yield* ReadyHelmChart(`${id}Chart`, {
      cluster: props.cluster,
      chart: "opentelemetry-collector",
      repo: "https://open-telemetry.github.io/opentelemetry-helm-charts",
      version: OTEL_COLLECTOR_CHART_VERSION,
      releaseName,
      namespace: namespaceName,
      createNamespace: false,
      timeoutSeconds: props.timeoutSeconds ?? 300,
      values: plan.values,
    });

    const endpoints = otelCollectorEndpoints(releaseName, namespaceName);
    return {
      namespace: namespaceName,
      releaseName,
      serviceName: releaseName,
      signals: plan.signals,
      ...endpoints,
    } satisfies OtelCollectorResult;
  });
