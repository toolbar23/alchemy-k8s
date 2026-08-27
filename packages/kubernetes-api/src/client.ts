import type { ClusterTransport } from "alchemy/Kubernetes";
import { findClusterAdapter, toConnection } from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  DeletionPropagation,
  KubernetesObject,
  ObjectRef,
} from "./types.ts";

export class KubernetesApiError extends Error {
  override readonly name = "KubernetesApiError";
  readonly immutable: boolean;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly statusCode: number,
    responseBody: string,
  ) {
    super(`Kubernetes API ${method} ${path} returned ${String(statusCode)}`);
    this.immutable =
      statusCode === 422 &&
      /immutable|may not change|updates? to [\s\S]*spec[\s\S]*forbidden/i.test(
        responseBody,
      );
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

export const requestJson = Effect.fn(function* ({
  transport,
  method,
  path,
  body,
  timeoutMs = 30_000,
  contentType,
}: {
  transport: ClusterTransport;
  method: "GET" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  contentType?: string;
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
                    "Content-Type": contentType ?? "application/json",
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
                reject(
                  new KubernetesApiError(
                    method,
                    path,
                    statusCode,
                    responseBody,
                  ),
                );
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

interface KindSpec {
  plural: string;
  namespaced: boolean;
}

const discoveredKinds = new Map<string, KindSpec>();

export const resolveKind = Effect.fn(function* ({
  transport,
  ref,
}: {
  transport: ClusterTransport;
  ref: Pick<ObjectRef, "apiVersion" | "kind">;
}) {
  const cacheKey = `${transport.endpoint}|${ref.apiVersion}|${ref.kind}`;
  const cached = discoveredKinds.get(cacheKey);
  if (cached !== undefined) return cached;
  const path = ref.apiVersion.includes("/")
    ? `/apis/${ref.apiVersion}`
    : `/api/${ref.apiVersion}`;
  const response = (yield* requestJson({
    transport,
    method: "GET",
    path,
  })) as {
    resources?: Array<{ name?: string; kind?: string; namespaced?: boolean }>;
  };
  const resource = response.resources?.find(
    (candidate) =>
      candidate.kind === ref.kind &&
      candidate.name !== undefined &&
      !candidate.name.includes("/"),
  );
  if (resource?.name === undefined) {
    return yield* Effect.fail(
      new KubernetesApiError(
        "GET",
        path,
        404,
        `Kind ${ref.kind} was not found`,
      ),
    );
  }
  const result = {
    plural: resource.name,
    namespaced: resource.namespaced === true,
  };
  discoveredKinds.set(cacheKey, result);
  return result;
});

export const objectPath = Effect.fn(function* ({
  transport,
  ref,
  collection = false,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
  collection?: boolean;
}) {
  const kind = yield* resolveKind({ transport, ref });
  const root = ref.apiVersion.includes("/")
    ? `/apis/${ref.apiVersion}`
    : `/api/${ref.apiVersion}`;
  if (kind.namespaced && ref.namespace === undefined) {
    return yield* Effect.fail(
      new Error(
        `${ref.apiVersion}/${ref.kind} ${ref.name} requires metadata.namespace`,
      ),
    );
  }
  const namespace = kind.namespaced
    ? `/namespaces/${encodeURIComponent(ref.namespace!)}`
    : "";
  return `${root}${namespace}/${kind.plural}${
    collection ? "" : `/${encodeURIComponent(ref.name)}`
  }`;
});

export const readObject = Effect.fn(function* ({
  transport,
  ref,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
}) {
  return (yield* requestJson({
    transport,
    method: "GET",
    path: yield* objectPath({ transport, ref }),
  })) as KubernetesObject;
});

export const applyObject = Effect.fn(function* ({
  transport,
  object,
  fieldManager,
  forceConflicts,
  dryRun = false,
}: {
  transport: ClusterTransport;
  object: KubernetesObject;
  fieldManager: string;
  forceConflicts: boolean;
  dryRun?: boolean;
}) {
  const ref: ObjectRef = {
    apiVersion: object.apiVersion,
    kind: object.kind,
    name: object.metadata.name,
    namespace: object.metadata.namespace,
  };
  const query = new URLSearchParams({ fieldManager });
  if (forceConflicts) query.set("force", "true");
  if (dryRun) query.set("dryRun", "All");
  return (yield* requestJson({
    transport,
    method: "PATCH",
    path: `${yield* objectPath({ transport, ref })}?${query.toString()}`,
    body: object,
    contentType: "application/apply-patch+yaml",
  })) as KubernetesObject;
});

export const deleteObject = Effect.fn(function* ({
  transport,
  ref,
  uid,
  propagationPolicy,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
  uid?: string;
  propagationPolicy: DeletionPropagation;
}) {
  return yield* requestJson({
    transport,
    method: "DELETE",
    path: yield* objectPath({ transport, ref }),
    body: {
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy,
      ...(uid === undefined ? {} : { preconditions: { uid } }),
    },
  }).pipe(
    Effect.catchIf(
      (error): error is KubernetesApiError =>
        error instanceof KubernetesApiError && error.statusCode === 404,
      () => Effect.void,
    ),
  );
});

export const watchObject = Effect.fn(function* ({
  transport,
  ref,
  resourceVersion,
  timeoutSeconds,
  accept,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
  resourceVersion?: string;
  timeoutSeconds: number;
  accept: (object: KubernetesObject | undefined) => boolean;
}) {
  const headers = yield* transport.headers;
  const basePath = yield* objectPath({ transport, ref, collection: true });
  const query = new URLSearchParams({
    watch: "true",
    allowWatchBookmarks: "true",
    fieldSelector: `metadata.name=${ref.name}`,
    timeoutSeconds: String(Math.max(1, Math.ceil(timeoutSeconds))),
  });
  if (resourceVersion !== undefined)
    query.set("resourceVersion", resourceVersion);
  const url = new URL(`${basePath}?${query.toString()}`, transport.endpoint);

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve, reject) => {
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: { ...headers, Accept: "application/json" },
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
            const statusCode = response.statusCode ?? 500;
            if (statusCode < 200 || statusCode >= 300) {
              response.resume();
              reject(new KubernetesApiError("GET", basePath, statusCode, ""));
              return;
            }
            let buffer = "";
            let settled = false;
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              buffer += chunk;
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (line.trim().length === 0) continue;
                const event = JSON.parse(line) as {
                  type?: string;
                  object?: KubernetesObject & {
                    code?: number;
                  };
                };
                if (event.type === "ERROR" && event.object?.code === 410) {
                  settled = true;
                  request.destroy();
                  reject(new KubernetesApiError("GET", basePath, 410, ""));
                  return;
                }
                if (event.type === "BOOKMARK") continue;
                const object =
                  event.type === "DELETED" ? undefined : event.object;
                if (accept(object)) {
                  settled = true;
                  request.destroy();
                  resolve(true);
                  return;
                }
              }
            });
            response.on("end", () => {
              if (!settled) resolve(false);
            });
          },
        );
        request.setTimeout((timeoutSeconds + 2) * 1000, () => {
          request.destroy();
          resolve(false);
        });
        request.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET")
            resolve(false);
          else reject(error);
        });
        request.end();
      }),
    catch: (error) =>
      error instanceof KubernetesApiError
        ? error
        : new Error("Kubernetes API watch failed"),
  });
});
