import type { ClusterTransport } from "alchemy/Kubernetes";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { KubernetesApiError, readObject, watchObject } from "./client.ts";
import type { KubernetesObject, ObjectRef, WaitFor } from "./types.ts";

export interface ReadinessResult {
  ready: boolean;
  terminal: boolean;
  detail: string;
}

type Condition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
};

const conditionsOf = (object: KubernetesObject): Condition[] => {
  const status = object.status as { conditions?: Condition[] } | undefined;
  return Array.isArray(status?.conditions) ? status.conditions : [];
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const conditionSummary = (conditions: Condition[]): string =>
  conditions
    .filter(({ type }) => type !== undefined)
    .map(
      ({ type, status, reason }) =>
        `${type}=${status ?? "Unknown"}${reason === undefined ? "" : `(${reason})`}`,
    )
    .join(", ") || "none";

export const jsonPathValue = (
  object: KubernetesObject,
  expression: string,
): unknown => {
  const path = expression
    .trim()
    .replace(/^\{?\$?\.?/, "")
    .replace(/\}?$/, "");
  if (path.length === 0) return object;
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = object;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

export const kubernetesObjectReadiness = (
  object: KubernetesObject,
  waitFor?: WaitFor,
): ReadinessResult => {
  const conditions = conditionsOf(object);
  const summary = conditionSummary(conditions);
  if (
    typeof object.metadata?.name !== "string" ||
    typeof object.metadata?.uid !== "string"
  ) {
    return {
      ready: false,
      terminal: false,
      detail: "waiting for a complete observed object",
    };
  }
  if (waitFor !== undefined) {
    if ("condition" in waitFor) {
      const expected = waitFor.status ?? "True";
      return {
        ready: conditions.some(
          ({ type, status }) =>
            type === waitFor.condition && status === expected,
        ),
        terminal: false,
        detail: `waiting for condition ${waitFor.condition}=${expected}; conditions: ${summary}`,
      };
    }
    const actual = jsonPathValue(object, waitFor.jsonPath);
    return {
      ready: JSON.stringify(actual) === JSON.stringify(waitFor.equals),
      terminal: false,
      detail: `waiting for ${waitFor.jsonPath}=${JSON.stringify(waitFor.equals)}; current=${JSON.stringify(actual)}`,
    };
  }

  const metadata = object.metadata;
  const generation = count(metadata.generation);
  const spec = object.spec as Record<string, unknown> | undefined;
  const status = object.status as Record<string, unknown> | undefined;
  const observed = count(status?.observedGeneration);

  switch (object.kind) {
    case "Namespace":
      return {
        ready: status?.phase === "Active",
        terminal: status?.phase === "Terminating",
        detail: `phase=${String(status?.phase ?? "Pending")}`,
      };
    case "CustomResourceDefinition":
      return {
        ready: conditions.some(
          ({ type, status: conditionStatus }) =>
            type === "Established" && conditionStatus === "True",
        ),
        terminal: conditions.some(
          ({ type, status: conditionStatus }) =>
            type === "NamesAccepted" && conditionStatus === "False",
        ),
        detail: `conditions: ${summary}`,
      };
    case "Pod":
      return {
        ready: conditions.some(
          ({ type, status: conditionStatus }) =>
            type === "Ready" && conditionStatus === "True",
        ),
        terminal: status?.phase === "Failed",
        detail: `phase=${String(status?.phase ?? "Pending")}, conditions: ${summary}`,
      };
    case "Deployment": {
      const desired = spec?.replicas === undefined ? 1 : count(spec.replicas);
      const available = count(status?.availableReplicas);
      return {
        ready: observed >= generation && available >= desired,
        terminal: conditions.some(
          ({ type, status: conditionStatus, reason }) =>
            type === "Progressing" &&
            conditionStatus === "False" &&
            reason === "ProgressDeadlineExceeded",
        ),
        detail: `observedGeneration=${String(observed)}/${String(generation)}, availableReplicas=${String(available)}/${String(desired)}, conditions: ${summary}`,
      };
    }
    case "StatefulSet": {
      const desired = spec?.replicas === undefined ? 1 : count(spec.replicas);
      const ready = count(status?.readyReplicas);
      return {
        ready: observed >= generation && ready >= desired,
        terminal: false,
        detail: `observedGeneration=${String(observed)}/${String(generation)}, readyReplicas=${String(ready)}/${String(desired)}, conditions: ${summary}`,
      };
    }
    case "DaemonSet": {
      const desired = count(status?.desiredNumberScheduled);
      const available = count(status?.numberAvailable);
      return {
        ready: observed >= generation && available >= desired,
        terminal: false,
        detail: `observedGeneration=${String(observed)}/${String(generation)}, numberAvailable=${String(available)}/${String(desired)}, conditions: ${summary}`,
      };
    }
    case "Job":
      return {
        ready: conditions.some(
          ({ type, status: conditionStatus }) =>
            (type === "Complete" || type === "SuccessCriteriaMet") &&
            conditionStatus === "True",
        ),
        terminal: conditions.some(
          ({ type, status: conditionStatus }) =>
            (type === "Failed" || type === "FailureTarget") &&
            conditionStatus === "True",
        ),
        detail: `conditions: ${summary}`,
      };
    case "PersistentVolumeClaim":
      return {
        ready: status?.phase === "Bound",
        terminal: status?.phase === "Lost",
        detail: `phase=${String(status?.phase ?? "Pending")}`,
      };
    case "Service": {
      if (spec?.type !== "LoadBalancer") {
        return { ready: true, terminal: false, detail: "service accepted" };
      }
      const loadBalancer = status?.loadBalancer as
        { ingress?: unknown[] } | undefined;
      return {
        ready: (loadBalancer?.ingress?.length ?? 0) > 0,
        terminal: false,
        detail: `loadBalancer.ingress=${String(loadBalancer?.ingress?.length ?? 0)}`,
      };
    }
    case "Ingress": {
      const loadBalancer = status?.loadBalancer as
        { ingress?: unknown[] } | undefined;
      return {
        ready: (loadBalancer?.ingress?.length ?? 0) > 0,
        terminal: false,
        detail: `loadBalancer.ingress=${String(loadBalancer?.ingress?.length ?? 0)}`,
      };
    }
    default:
      return { ready: true, terminal: false, detail: "object accepted" };
  }
};

export class KubernetesReadinessError extends Error {
  override readonly name = "KubernetesReadinessError";

  constructor(
    message: string,
    readonly ref: ObjectRef,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

const label = (ref: ObjectRef): string =>
  `${ref.apiVersion}/${ref.kind} ${ref.namespace === undefined ? "" : `${ref.namespace}/`}${ref.name}`;

export const waitForObjectReady = Effect.fn(function* ({
  transport,
  ref,
  timeoutSeconds,
  waitFor,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
  timeoutSeconds: number;
  waitFor?: WaitFor;
}) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* Effect.fail(
      new Error("Kubernetes timeoutSeconds must be greater than zero"),
    );
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastDetail = "object not found";
  while (Date.now() < deadline) {
    let observed = yield* readObject({ transport, ref }).pipe(
      Effect.catchIf(
        (error): error is KubernetesApiError =>
          error instanceof KubernetesApiError && error.statusCode === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (observed !== undefined) {
      const readiness = kubernetesObjectReadiness(observed, waitFor);
      lastDetail = readiness.detail;
      if (readiness.ready) return observed;
      if (readiness.terminal) {
        return yield* Effect.fail(
          new KubernetesReadinessError(
            `${label(ref)} reached a terminal state: ${readiness.detail}`,
            ref,
            false,
          ),
        );
      }
    }
    const remainingSeconds = Math.max(1, (deadline - Date.now()) / 1000);
    const watched = yield* watchObject({
      transport,
      ref,
      ...(observed?.metadata.resourceVersion === undefined
        ? {}
        : { resourceVersion: observed.metadata.resourceVersion }),
      timeoutSeconds: Math.min(15, remainingSeconds),
      accept: (candidate) => {
        observed = candidate;
        if (candidate === undefined) return false;
        const readiness = kubernetesObjectReadiness(candidate, waitFor);
        lastDetail = readiness.detail;
        return readiness.ready || readiness.terminal;
      },
    }).pipe(
      Effect.catchIf(
        (error): error is KubernetesApiError =>
          error instanceof KubernetesApiError && error.statusCode === 410,
        () => Effect.succeed(false),
      ),
    );
    if (watched && observed !== undefined) {
      const readiness = kubernetesObjectReadiness(observed, waitFor);
      if (readiness.ready) return observed;
      if (readiness.terminal) {
        return yield* Effect.fail(
          new KubernetesReadinessError(
            `${label(ref)} reached a terminal state: ${readiness.detail}`,
            ref,
            false,
          ),
        );
      }
    }
    if (Date.now() < deadline) yield* Effect.sleep(Duration.millis(250));
  }
  return yield* Effect.fail(
    new KubernetesReadinessError(
      `Timed out waiting for ${label(ref)}: ${lastDetail}`,
      ref,
      true,
    ),
  );
});

export const waitForObjectDeleted = Effect.fn(function* ({
  transport,
  ref,
  uid,
  timeoutSeconds,
}: {
  transport: ClusterTransport;
  ref: ObjectRef;
  uid?: string;
  timeoutSeconds: number;
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let finalizers: string[] = [];
  while (Date.now() < deadline) {
    let observed = yield* readObject({ transport, ref }).pipe(
      Effect.catchIf(
        (error): error is KubernetesApiError =>
          error instanceof KubernetesApiError && error.statusCode === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (observed === undefined) return;
    if (uid !== undefined && observed.metadata.uid !== uid) {
      return yield* Effect.fail(
        new Error(
          `Refusing to treat ${label(ref)} as deleted: UID changed from ${uid} to ${String(observed.metadata.uid)}`,
        ),
      );
    }
    finalizers = observed.metadata.finalizers ?? [];
    const remainingSeconds = Math.max(1, (deadline - Date.now()) / 1000);
    const deleted = yield* watchObject({
      transport,
      ref,
      ...(observed.metadata.resourceVersion === undefined
        ? {}
        : { resourceVersion: observed.metadata.resourceVersion }),
      timeoutSeconds: Math.min(15, remainingSeconds),
      accept: (candidate) => {
        observed = candidate;
        return candidate === undefined;
      },
    }).pipe(
      Effect.catchIf(
        (error): error is KubernetesApiError =>
          error instanceof KubernetesApiError && error.statusCode === 410,
        () => Effect.succeed(false),
      ),
    );
    if (deleted || observed === undefined) return;
  }
  return yield* Effect.fail(
    new KubernetesReadinessError(
      `Timed out deleting ${label(ref)}${finalizers.length === 0 ? "" : `; blocking finalizers: ${finalizers.join(", ")}`}`,
      ref,
      true,
    ),
  );
});
