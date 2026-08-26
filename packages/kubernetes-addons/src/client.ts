import type { ClusterTransport } from "alchemy/Kubernetes";
import { findClusterAdapter, toConnection } from "alchemy/Kubernetes";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface KubernetesObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

export class KubernetesApiError extends Error {
  override readonly name = "KubernetesApiError";

  constructor(
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`Kubernetes API returned ${String(statusCode)}`);
  }
}

export const connectCluster = Effect.fn(function* (
  cluster: Parameters<typeof toConnection>[0],
) {
  const connection = toConnection(cluster);
  const adapter = yield* findClusterAdapter(connection.auth.kind);
  return {
    connection,
    transport: yield* adapter.connect(connection),
  };
});

const plurals = new Map([
  ["v1/Secret", "secrets"],
  [
    "apiextensions.k8s.io/v1/CustomResourceDefinition",
    "customresourcedefinitions",
  ],
  ["apps/v1/Deployment", "deployments"],
  ["apps/v1/DaemonSet", "daemonsets"],
  ["apps/v1/StatefulSet", "statefulsets"],
  ["batch/v1/Job", "jobs"],
]);

export const objectPath = (object: KubernetesObjectRef): string => {
  const plural = plurals.get(`${object.apiVersion}/${object.kind}`);
  if (plural === undefined) {
    throw new Error(
      `Readiness is not implemented for ${object.apiVersion}/${object.kind}`,
    );
  }
  const root =
    object.apiVersion === "v1" ? "/api/v1" : `/apis/${object.apiVersion}`;
  const namespace =
    object.kind === "CustomResourceDefinition"
      ? ""
      : `/namespaces/${encodeURIComponent(object.namespace ?? "default")}`;
  return `${root}${namespace}/${plural}/${encodeURIComponent(object.name)}`;
};

export const requestJson = Effect.fn(function* ({
  transport,
  method,
  path,
  body,
  timeoutMs = 30_000,
}: {
  transport: ClusterTransport;
  method: "GET" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}) {
  const headers = yield* transport.headers;
  const url = new URL(path, transport.endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return yield* Effect.fail(
      new Error(`Unsupported Kubernetes API protocol: ${url.protocol}`),
    );
  }
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname)
  ) {
    return yield* Effect.fail(
      new Error("Refusing to send Kubernetes credentials over remote HTTP"),
    );
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              ...headers,
              Accept: "application/json",
              ...(payload === undefined
                ? {}
                : {
                    "Content-Type": "application/apply-patch+yaml",
                    "Content-Length": Buffer.byteLength(payload),
                  }),
            },
            ...(url.protocol === "https:" &&
            transport.certificateAuthorityData !== undefined
              ? {
                  ca: Buffer.from(
                    transport.certificateAuthorityData,
                    "base64",
                  ).toString("utf8"),
                }
              : {}),
            ...(url.protocol === "https:" && transport.clientCert !== undefined
              ? {
                  cert: transport.clientCert.certificate,
                  key: transport.clientCert.key,
                }
              : {}),
            ...(url.protocol === "https:" && transport.insecureSkipTlsVerify
              ? { rejectUnauthorized: false }
              : {}),
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) =>
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
            );
            response.on("end", () => {
              const responseBody = Buffer.concat(chunks).toString("utf8");
              const statusCode = response.statusCode ?? 500;
              if (statusCode < 200 || statusCode >= 300) {
                reject(new KubernetesApiError(statusCode, responseBody));
                return;
              }
              if (responseBody.trim().length === 0) {
                resolve(undefined);
                return;
              }
              try {
                resolve(JSON.parse(responseBody));
              } catch {
                reject(new Error("Kubernetes API returned invalid JSON"));
              }
            });
          },
        );
        request.setTimeout(timeoutMs, () =>
          request.destroy(new Error("Kubernetes API request timed out")),
        );
        request.on("error", reject);
        if (payload !== undefined) request.write(payload);
        request.end();
      }),
    catch: (error) =>
      error instanceof KubernetesApiError
        ? error
        : new Error("Kubernetes API request failed"),
  });
});

export interface KubernetesObjectReadiness {
  ready: boolean;
  terminal: boolean;
  detail: string;
}

type Condition = {
  type?: string;
  status?: string;
  reason?: string;
};

const conditionSummary = (conditions: Condition[]): string =>
  conditions
    .filter(({ type }) =>
      [
        "Established",
        "NamesAccepted",
        "Progressing",
        "Available",
        "ReplicaFailure",
        "Complete",
        "Failed",
        "FailureTarget",
        "SuccessCriteriaMet",
        "Suspended",
      ].includes(type ?? ""),
    )
    .map(
      ({ type, status }) =>
        `${type}=${["True", "False", "Unknown"].includes(status ?? "") ? status : "Unknown"}`,
    )
    .join(", ") || "none";

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
};

export const kubernetesObjectReadiness = (
  object: unknown,
): KubernetesObjectReadiness => {
  const value = object as {
    kind?: string;
    metadata?: { generation?: number };
    spec?: { replicas?: number };
    status?: {
      observedGeneration?: number;
      availableReplicas?: number;
      desiredNumberScheduled?: number;
      numberAvailable?: number;
      readyReplicas?: number;
      conditions?: Condition[];
    };
  };
  const generation = count(value.metadata?.generation);
  const observed = count(value.status?.observedGeneration);
  const conditions = value.status?.conditions ?? [];
  const summary = conditionSummary(conditions);

  if (value.kind === "CustomResourceDefinition") {
    return {
      ready: conditions.some(
        ({ type, status }) => type === "Established" && status === "True",
      ),
      terminal: conditions.some(
        ({ type, status }) => type === "NamesAccepted" && status === "False",
      ),
      detail: `conditions: ${summary}`,
    };
  }
  if (value.kind === "Deployment") {
    const desired =
      value.spec?.replicas === undefined ? 1 : count(value.spec.replicas);
    const available = count(value.status?.availableReplicas);
    return {
      ready: observed >= generation && available >= desired,
      terminal: conditions.some(
        ({ type, status, reason }) =>
          type === "Progressing" &&
          status === "False" &&
          reason === "ProgressDeadlineExceeded",
      ),
      detail: `observedGeneration=${String(observed)}/${String(generation)}, availableReplicas=${String(available)}/${String(desired)}, conditions: ${summary}`,
    };
  }
  if (value.kind === "DaemonSet") {
    const desired = count(value.status?.desiredNumberScheduled);
    const available = count(value.status?.numberAvailable);
    return {
      ready: observed >= generation && available >= desired,
      terminal: false,
      detail: `observedGeneration=${String(observed)}/${String(generation)}, numberAvailable=${String(available)}/${String(desired)}, conditions: ${summary}`,
    };
  }
  if (value.kind === "StatefulSet") {
    const desired =
      value.spec?.replicas === undefined ? 1 : count(value.spec.replicas);
    const ready = count(value.status?.readyReplicas);
    return {
      ready: observed >= generation && ready >= desired,
      terminal: false,
      detail: `observedGeneration=${String(observed)}/${String(generation)}, readyReplicas=${String(ready)}/${String(desired)}, conditions: ${summary}`,
    };
  }
  if (value.kind === "Job") {
    return {
      ready: conditions.some(
        ({ type, status }) => type === "Complete" && status === "True",
      ),
      terminal: conditions.some(
        ({ type, status }) => type === "Failed" && status === "True",
      ),
      detail: `conditions: ${summary}`,
    };
  }
  return { ready: true, terminal: false, detail: "no readiness gate" };
};

const waitedKinds = new Set([
  "CustomResourceDefinition",
  "Deployment",
  "DaemonSet",
  "StatefulSet",
  "Job",
]);

const objectLabel = (object: KubernetesObjectRef): string =>
  `${object.apiVersion}/${object.kind} ${object.namespace ? `${object.namespace}/` : ""}${object.name}`;

export class KubernetesReadinessError extends Error {
  override readonly name = "KubernetesReadinessError";

  constructor(
    message: string,
    readonly object: KubernetesObjectRef,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

export const waitForObjectsReady = Effect.fn(function* ({
  transport,
  objects,
  timeoutSeconds,
}: {
  transport: ClusterTransport;
  objects: ReadonlyArray<KubernetesObjectRef>;
  timeoutSeconds: number;
}) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* Effect.fail(
      new Error(
        "Kubernetes readiness timeoutSeconds must be greater than zero",
      ),
    );
  }
  const waiting = objects.filter(({ kind }) => waitedKinds.has(kind));
  if (waiting.length === 0) return;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastPending:
    | { object: KubernetesObjectRef; readiness: KubernetesObjectReadiness }
    | undefined;

  while (true) {
    if (Date.now() >= deadline) {
      const pending = lastPending ?? {
        object: waiting[0]!,
        readiness: { detail: "deadline reached" },
      };
      return yield* Effect.fail(
        new KubernetesReadinessError(
          `Timed out waiting for ${objectLabel(pending.object)}: ${pending.readiness.detail}`,
          pending.object,
          true,
        ),
      );
    }
    lastPending = undefined;
    for (const object of waiting) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const observed = yield* requestJson({
        transport,
        method: "GET",
        path: objectPath(object),
        timeoutMs: Math.min(30_000, remaining),
      }).pipe(
        Effect.catchIf(
          (error): error is KubernetesApiError =>
            error instanceof KubernetesApiError && error.statusCode === 404,
          () => Effect.succeed(undefined),
        ),
        Effect.mapError(
          (error) =>
            new KubernetesReadinessError(
              `Failed to inspect ${objectLabel(object)}${error instanceof KubernetesApiError ? `: Kubernetes API returned ${String(error.statusCode)}` : ""}`,
              object,
              false,
            ),
        ),
      );
      const readiness =
        observed === undefined
          ? { ready: false, terminal: false, detail: "object not found" }
          : kubernetesObjectReadiness(observed);
      if (readiness.terminal) {
        return yield* Effect.fail(
          new KubernetesReadinessError(
            `${objectLabel(object)} reached a terminal failure: ${readiness.detail}`,
            object,
            false,
          ),
        );
      }
      if (!readiness.ready && lastPending === undefined) {
        lastPending = { object, readiness };
      }
    }
    if (lastPending === undefined && Date.now() < deadline) return;
    if (Date.now() >= deadline) {
      const pending = lastPending ?? {
        object: waiting[0]!,
        readiness: { detail: "deadline reached" },
      };
      return yield* Effect.fail(
        new KubernetesReadinessError(
          `Timed out waiting for ${objectLabel(pending.object)}: ${pending.readiness.detail}`,
          pending.object,
          true,
        ),
      );
    }
    yield* Effect.sleep(
      Duration.millis(Math.min(2_000, deadline - Date.now())),
    );
  }
});
