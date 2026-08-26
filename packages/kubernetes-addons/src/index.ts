import {
  RandomProvider,
  Resource,
  isResolved,
  type Input,
  type PropsInput,
  type Resource as ResourceInstance,
} from "alchemy";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  connectCluster,
  KubernetesApiError,
  objectPath,
  requestJson,
  waitForObjectsReady,
  type KubernetesObjectRef,
} from "./client.ts";

export {
  CloudflareExternalDns,
  EXTERNAL_DNS_CHART_VERSION,
  EXTERNAL_DNS_IMAGE,
  type CloudflareExternalDnsProps,
  type CloudflareExternalDnsResult,
} from "./cloudflare-external-dns.ts";

export {
  CERT_MANAGER_CHART,
  CERT_MANAGER_CHART_VERSION,
  CertManager,
  certManagerHelmValues,
  validateCertManagerProps,
  type CertManagerProps,
  type CertManagerResult,
} from "./cert-manager.ts";

export {
  CloudflareAcmeIssuer,
  LETSENCRYPT_PRODUCTION_URL,
  LETSENCRYPT_STAGING_URL,
  cloudflareAcmeIssuerManifest,
  cloudflareAcmeIssuerName,
  cloudflareAcmeIssuerTokenPolicies,
  validateCloudflareAcmeIssuerProps,
  type CloudflareAcmeIssuerProps,
  type CloudflareAcmeIssuerResult,
} from "./cloudflare-acme-issuer.ts";

export {
  OTEL_COLLECTOR_CHART_VERSION,
  OTEL_COLLECTOR_IMAGE,
  OtelCollector,
  type OtelCollectorBasicAuthSecretRef,
  type OtelCollectorDestination,
  type OtelCollectorProps,
  type OtelCollectorResult,
  type OtelSignal,
} from "./otel-collector.ts";

export {
  PARSEABLE_CHART_VERSION,
  PARSEABLE_IMAGE,
  Parseable,
  type ParseableIngressProps,
  type ParseableOtlpEndpoints,
  type ParseableProps,
  type ParseableResult,
  type ParseableStagingProps,
} from "./parseable.ts";

export {
  kubernetesObjectReadiness,
  KubernetesReadinessError,
  type KubernetesObjectReadiness,
  type KubernetesObjectRef,
} from "./client.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "KubernetesAddons",
) {}

export interface SecretProps {
  cluster: Kubernetes.ClusterLike;
  name: string;
  namespace?: string;
  type?: string;
  immutable?: boolean;
  stringData: Record<string, string | Redacted.Redacted<string>>;
}

export type Secret = ResourceInstance<
  "KubernetesAddons.Secret",
  SecretProps,
  {
    connection: Kubernetes.Connection;
    name: string;
    namespace: string;
    type: string;
    uid: string | undefined;
    resourceVersion: string | undefined;
  },
  Record<never, never>,
  Providers
>;

const SecretResource = Resource<Secret>("KubernetesAddons.Secret");

const toRedacted = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

const liftValue = (
  value: Input<string | Redacted.Redacted<string>>,
): Input<Redacted.Redacted<string>> =>
  Config.isConfig(value)
    ? Config.map(value, toRedacted)
    : Effect.isEffect(value)
      ? Effect.map(value, toRedacted)
      : Output.isOutput(value)
        ? Output.map(
            value as Output.Output<string | Redacted.Redacted<string>>,
            toRedacted,
          )
        : toRedacted(value as string | Redacted.Redacted<string>);

const redactProps = Effect.fn(function* (props: PropsInput<SecretProps>) {
  const stringData = yield* Effect.all(
    Object.entries(props.stringData).map(([key, value]) =>
      Effect.isEffect(value) && !Config.isConfig(value)
        ? Effect.map(
            Effect.orDie(
              Effect.mapError(
                value,
                () => new Error("Failed to resolve Kubernetes Secret input"),
              ),
            ),
            (resolved) => [key, toRedacted(resolved)] as const,
          )
        : Effect.succeed([key, liftValue(value)] as const),
    ),
    { concurrency: "unbounded" },
  );
  return { ...props, stringData: Object.fromEntries(stringData) };
});

/** Write-only Kubernetes Secret with Redacted request-boundary handling. */
export const Secret = Object.assign(
  (
    id: string,
    props:
      | PropsInput<SecretProps>
      | Effect.Effect<PropsInput<SecretProps>, never, any>,
  ) =>
    Effect.isEffect(props)
      ? SecretResource(id, Effect.flatMap(props, redactProps))
      : SecretResource(id, redactProps(props)),
  SecretResource,
) as typeof SecretResource;

const safeSecretError = (
  operation: "apply" | "delete" | "read",
  name: string,
  namespace: string,
  error: unknown,
): Error =>
  new Error(
    `Failed to ${operation} Kubernetes Secret ${namespace}/${name}${
      error instanceof KubernetesApiError
        ? `: Kubernetes API returned ${String(error.statusCode)}`
        : ""
    }`,
  );

const connectionIdentity = (connection: Kubernetes.Connection): string => {
  const auth = Object.fromEntries(
    Object.entries(connection.auth).filter(
      ([key]) => !["token", "key", "certificate", "env"].includes(key),
    ),
  );
  return JSON.stringify({ endpoint: connection.endpoint, auth });
};

const secretRef = (value: {
  name: string;
  namespace: string;
}): KubernetesObjectRef => ({
  apiVersion: "v1",
  kind: "Secret",
  name: value.name,
  namespace: value.namespace,
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["connection", "name", "namespace"],
    list: () => Effect.succeed([] as Secret["Attributes"][]),
    diff: ({ olds = {} as SecretProps, news }) =>
      Effect.sync(() => {
        if (!isResolved(news)) return undefined;
        if (
          (olds.cluster !== undefined &&
            connectionIdentity(Kubernetes.toConnection(olds.cluster)) !==
              connectionIdentity(Kubernetes.toConnection(news.cluster))) ||
          olds.name !== news.name ||
          (olds.namespace ?? "default") !== (news.namespace ?? "default")
        ) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
    read: ({ output }) =>
      Effect.gen(function* () {
        if (output === undefined) return undefined;
        const connected = yield* connectCluster(output.connection).pipe(
          Effect.catchIf(
            (error) => error instanceof Kubernetes.ClusterNotFoundError,
            () => Effect.succeed(undefined),
          ),
          Effect.mapError((error) =>
            safeSecretError("read", output.name, output.namespace, error),
          ),
        );
        if (connected === undefined) return undefined;
        const observed = yield* requestJson({
          transport: connected.transport,
          method: "GET",
          path: objectPath(secretRef(output)),
        }).pipe(
          Effect.catchIf(
            (error): error is KubernetesApiError =>
              error instanceof KubernetesApiError && error.statusCode === 404,
            () => Effect.succeed(undefined),
          ),
          Effect.mapError((error) =>
            safeSecretError("read", output.name, output.namespace, error),
          ),
        );
        if (observed === undefined) return undefined;
        const secret = observed as {
          type?: string;
          metadata?: { uid?: string; resourceVersion?: string };
        };
        return {
          ...output,
          type: secret.type ?? output.type,
          uid: secret.metadata?.uid ?? output.uid,
          resourceVersion:
            secret.metadata?.resourceVersion ?? output.resourceVersion,
        };
      }),
    reconcile: ({ news, session }) =>
      Effect.gen(function* () {
        const namespace = news.namespace ?? "default";
        const connected = yield* connectCluster(news.cluster).pipe(
          Effect.mapError((error) =>
            safeSecretError("apply", news.name, namespace, error),
          ),
        );
        const applied = yield* requestJson({
          transport: connected.transport,
          method: "PATCH",
          path: `${objectPath(
            secretRef({ name: news.name, namespace }),
          )}?fieldManager=alchemy-kubernetes-addons&force=true`,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: news.name, namespace },
            type: news.type ?? "Opaque",
            ...(news.immutable === undefined
              ? {}
              : { immutable: news.immutable }),
            stringData: Object.fromEntries(
              Object.entries(news.stringData).map(([key, value]) => [
                key,
                Redacted.value(value as Redacted.Redacted<string>),
              ]),
            ),
          },
        }).pipe(
          Effect.mapError((error) =>
            safeSecretError("apply", news.name, namespace, error),
          ),
        );
        const result = applied as {
          type?: string;
          metadata?: { uid?: string; resourceVersion?: string };
        };
        yield* session.note(
          `Applied Kubernetes Secret ${namespace}/${news.name}`,
        );
        return {
          connection: connected.connection,
          name: news.name,
          namespace,
          type: result.type ?? news.type ?? "Opaque",
          uid: result.metadata?.uid,
          resourceVersion: result.metadata?.resourceVersion,
        };
      }),
    delete: ({ output }) =>
      Effect.gen(function* () {
        const connected = yield* connectCluster(output.connection).pipe(
          Effect.catchIf(
            (error) => error instanceof Kubernetes.ClusterNotFoundError,
            () => Effect.succeed(undefined),
          ),
          Effect.mapError((error) =>
            safeSecretError("delete", output.name, output.namespace, error),
          ),
        );
        if (connected === undefined) return;
        yield* requestJson({
          transport: connected.transport,
          method: "DELETE",
          path: objectPath(secretRef(output)),
        }).pipe(
          Effect.catchIf(
            (error): error is KubernetesApiError =>
              error instanceof KubernetesApiError && error.statusCode === 404,
            () => Effect.void,
          ),
          Effect.mapError((error) =>
            safeSecretError("delete", output.name, output.namespace, error),
          ),
        );
      }),
  });

export interface ReadinessProps {
  cluster: Kubernetes.ClusterLike;
  objects: KubernetesObjectRef[];
  revision: string;
  timeoutSeconds?: number;
}

export type Readiness = ResourceInstance<
  "KubernetesAddons.Readiness",
  ReadinessProps,
  {
    connection: Kubernetes.Connection;
    objects: KubernetesObjectRef[];
    revision: string;
  },
  Record<never, never>,
  Providers
>;

export const Readiness = Resource<Readiness>("KubernetesAddons.Readiness");

export const ReadinessProvider = () =>
  Provider.succeed(Readiness, {
    list: () => Effect.succeed([] as Readiness["Attributes"][]),
    read: ({ output }) => Effect.succeed(output),
    reconcile: ({ news }) =>
      Effect.gen(function* () {
        const connected = yield* connectCluster(news.cluster).pipe(
          Effect.mapError(
            () => new Error("Failed to connect to Kubernetes for readiness"),
          ),
        );
        yield* waitForObjectsReady({
          transport: connected.transport,
          objects: news.objects,
          timeoutSeconds: news.timeoutSeconds ?? 300,
        });
        return {
          connection: connected.connection,
          objects: [...news.objects],
          revision: news.revision,
        };
      }),
    delete: () => Effect.void,
  });

export interface ReadyHelmChartProps extends Omit<
  Kubernetes.HelmChartProps,
  "cluster" | "wait" | "timeoutSeconds"
> {
  cluster: Input<Kubernetes.ClusterLike>;
  timeoutSeconds?: number;
}

/** Apply an Alchemy Helm chart, then wait for its CRDs and workloads. */
export const ReadyHelmChart = (id: string, props: ReadyHelmChartProps) =>
  Effect.gen(function* () {
    const { timeoutSeconds, ...chartProps } = props;
    const chart = yield* Kubernetes.HelmChart(id, chartProps);
    yield* Readiness(`${id}Readiness`, {
      cluster: chart.connection,
      objects: chart.objects,
      revision: chart.code.hash,
      timeoutSeconds: timeoutSeconds ?? 300,
    });
    return chart;
  });

export const providers = () =>
  Layer.effect(Providers, Provider.collection([Secret, Readiness])).pipe(
    Layer.provide(Layer.mergeAll(SecretProvider(), ReadinessProvider())),
    Layer.provideMerge(RandomProvider()),
  );
