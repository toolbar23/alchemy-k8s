import { createHash } from "node:crypto";
import { RandomProvider, isResolved } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  applyObject,
  connectCluster,
  deleteObject,
  KubernetesApiError,
  readObject,
} from "./client.ts";
import { Providers } from "./providers.ts";
import { waitForObjectDeleted, waitForObjectReady } from "./readiness.ts";
import { ObjectResource } from "./resource.ts";
import type {
  KubernetesObject,
  ObjectAttributes,
  ObjectProps,
  ObjectRef,
} from "./types.ts";

export const FQN_ANNOTATION = "alchemy.run/fqn";
export const INSTANCE_ANNOTATION = "alchemy.run/instance-id";

const serverMetadata = new Set([
  "uid",
  "resourceVersion",
  "generation",
  "creationTimestamp",
  "deletionTimestamp",
  "deletionGracePeriodSeconds",
  "managedFields",
  "selfLink",
]);

const connectionIdentity = (cluster: Kubernetes.ClusterLike): string => {
  const connection = Kubernetes.toConnection(cluster);
  const auth = connection.auth as unknown as Record<string, unknown>;
  return JSON.stringify({
    endpoint: connection.endpoint,
    certificateAuthorityData: connection.certificateAuthorityData,
    insecureSkipTlsVerify: connection.insecureSkipTlsVerify,
    auth: Object.fromEntries(
      Object.entries(auth).map(([key, value]) => [
        key,
        ["token", "key", "certificate", "env"].includes(key)
          ? "<credential>"
          : value,
      ]),
    ),
  });
};

const refOf = (object: KubernetesObject): ObjectRef => ({
  apiVersion: object.apiVersion,
  kind: object.kind,
  name: object.metadata.name,
  namespace: object.metadata.namespace,
});

const fieldManagerOf = (fqn: string, requested?: string): string => {
  const manager =
    requested ??
    `alchemy-${createHash("sha256").update(fqn).digest("hex").slice(0, 20)}`;
  if (manager.length === 0 || manager.length > 128) {
    throw new Error("Kubernetes fieldManager must contain 1 to 128 characters");
  }
  return manager;
};

export const desiredObject = ({
  props,
  fqn,
  instanceId,
}: {
  props: ObjectProps;
  fqn: string;
  instanceId: string;
}): KubernetesObject => {
  if (props.manifest.kind === "Secret") {
    throw new Error(
      "Kubernetes Secret is intentionally unavailable through KubernetesApi.Object; use KubernetesAddons.Secret so values never enter plans or live attributes",
    );
  }
  if (
    typeof props.manifest.apiVersion !== "string" ||
    props.manifest.apiVersion.length === 0 ||
    typeof props.manifest.kind !== "string" ||
    props.manifest.kind.length === 0 ||
    typeof props.manifest.metadata?.name !== "string" ||
    props.manifest.metadata.name.length === 0
  ) {
    throw new Error(
      "Kubernetes objects require apiVersion, kind, and metadata.name",
    );
  }
  const metadata = Object.fromEntries(
    Object.entries(props.manifest.metadata).filter(
      ([key]) => !serverMetadata.has(key),
    ),
  );
  if ((props.mode ?? "object") === "object") {
    metadata.annotations = {
      ...((metadata.annotations as Record<string, string> | undefined) ?? {}),
      [FQN_ANNOTATION]: fqn,
      [INSTANCE_ANNOTATION]: instanceId,
    };
  }
  return {
    ...Object.fromEntries(
      Object.entries(props.manifest).filter(
        ([key]) => key !== "status" && key !== "metadata",
      ),
    ),
    metadata: metadata as KubernetesObject["metadata"],
  } as KubernetesObject;
};

export const sanitizeObservedObject = (
  object: KubernetesObject,
): KubernetesObject => {
  const metadata = Object.fromEntries(
    Object.entries(object.metadata).filter(([key]) => key !== "managedFields"),
  );
  return { ...object, metadata: metadata as KubernetesObject["metadata"] };
};

const attributesOf = ({
  connection,
  object,
  mode,
}: {
  connection: Kubernetes.Connection;
  object: KubernetesObject;
  mode: "object" | "patch";
}): ObjectAttributes => {
  const live = sanitizeObservedObject(object);
  const ref = refOf(live);
  return {
    connection,
    ref,
    apiVersion: ref.apiVersion,
    kind: ref.kind,
    name: ref.name,
    namespace: ref.namespace,
    uid: live.metadata.uid,
    resourceVersion: live.metadata.resourceVersion,
    generation: live.metadata.generation,
    metadata: live.metadata,
    spec: live.spec,
    status: live.status,
    live,
    mode,
  };
};

const mergeKey = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Record<string, unknown>;
  for (const key of [
    "name",
    "key",
    "port",
    "containerPort",
    "mountPath",
    "type",
    "topologyKey",
  ]) {
    if (["string", "number", "boolean"].includes(typeof item[key])) {
      return `${key}:${String(item[key])}`;
    }
  }
  return undefined;
};

export const desiredProjection = (
  desired: unknown,
  observed: unknown,
): unknown => {
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed)) return observed;
    return desired.map((item, index) => {
      const key = mergeKey(item);
      const candidate =
        key === undefined
          ? observed[index]
          : observed.find((observedItem) => mergeKey(observedItem) === key);
      return desiredProjection(item, candidate);
    });
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return observed;
    return Object.fromEntries(
      Object.entries(desired as Record<string, unknown>).map(([key, value]) => [
        key,
        desiredProjection(value, (observed as Record<string, unknown>)[key]),
      ]),
    );
  }
  return observed;
};

const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const valueAtPath = (value: unknown, path: string): unknown => {
  const segments = path
    .replace(/^\$?\.?/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const isNotFound = (error: unknown): error is KubernetesApiError =>
  error instanceof KubernetesApiError && error.statusCode === 404;

export const ObjectProvider = () =>
  Provider.succeed(ObjectResource, {
    stables: ["connection", "apiVersion", "kind", "name", "namespace", "ref"],
    nuke: { skip: true },
    read: ({ fqn, instanceId, olds, output }) =>
      Effect.gen(function* () {
        const cluster = output?.connection ?? olds.cluster;
        const connected = yield* connectCluster(cluster).pipe(
          Effect.catchIf(
            (error) => error instanceof Kubernetes.ClusterNotFoundError,
            () => Effect.succeed(undefined),
          ),
        );
        if (connected === undefined) return undefined;
        const desired = desiredObject({ props: olds, fqn, instanceId });
        const ref = output?.ref ?? refOf(desired);
        const observed = yield* readObject({
          transport: connected.transport,
          ref,
        }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
        if (observed === undefined) return undefined;
        const mode = olds.mode ?? output?.mode ?? "object";
        const attributes = attributesOf({
          connection: connected.connection,
          object: observed,
          mode,
        });
        if (mode === "patch") return attributes;
        const annotations = observed.metadata.annotations ?? {};
        return annotations[FQN_ANNOTATION] === fqn &&
          annotations[INSTANCE_ANNOTATION] === instanceId
          ? attributes
          : Unowned(attributes);
      }),
    diff: ({ fqn, instanceId, olds, news, output }) =>
      Effect.gen(function* () {
        if (!isResolved(news)) return undefined;
        const oldDesired = desiredObject({ props: olds, fqn, instanceId });
        const nextDesired = desiredObject({ props: news, fqn, instanceId });
        const oldRef = refOf(oldDesired);
        const nextRef = refOf(nextDesired);
        if (
          connectionIdentity(olds.cluster) !==
            connectionIdentity(news.cluster) ||
          !equalJson(oldRef, nextRef)
        ) {
          const samePhysicalName =
            connectionIdentity(olds.cluster) ===
              connectionIdentity(news.cluster) &&
            oldRef.apiVersion === nextRef.apiVersion &&
            oldRef.kind === nextRef.kind &&
            oldRef.name === nextRef.name &&
            oldRef.namespace === nextRef.namespace;
          return { action: "replace", deleteFirst: samePhysicalName } as const;
        }
        for (const path of news.replaceOnChanges ?? []) {
          if (
            !equalJson(
              valueAtPath(oldDesired, path),
              valueAtPath(nextDesired, path),
            )
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }
        }
        const connected =
          output === undefined
            ? undefined
            : yield* connectCluster(news.cluster);
        const live =
          connected === undefined
            ? undefined
            : yield* readObject({
                transport: connected.transport,
                ref: nextRef,
              }).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
        const persistedAnnotations = output?.live.metadata.annotations ?? {};
        const takingOwnership =
          output !== undefined &&
          (news.mode ?? "object") === "object" &&
          (persistedAnnotations[FQN_ANNOTATION] !== fqn ||
            persistedAnnotations[INSTANCE_ANNOTATION] !== instanceId);
        if (
          live !== undefined &&
          (news.mode ?? "object") === "object" &&
          !takingOwnership
        ) {
          const liveAnnotations = live.metadata.annotations ?? {};
          if (
            (output?.uid !== undefined && live.metadata.uid !== output.uid) ||
            liveAnnotations[FQN_ANNOTATION] !== fqn ||
            liveAnnotations[INSTANCE_ANNOTATION] !== instanceId
          ) {
            return yield* Effect.fail(
              new Error(
                `Kubernetes object ${nextRef.apiVersion}/${nextRef.kind} ${nextRef.namespace ?? "_cluster"}/${nextRef.name} no longer has this resource's UID and ownership annotations; refusing to mutate a replacement object`,
              ),
            );
          }
        }
        const desiredChanged = !equalJson(oldDesired, nextDesired);
        const objectDrifted =
          live === undefined ||
          !equalJson(nextDesired, desiredProjection(nextDesired, live));
        const lifecycleChanged = !equalJson(
          {
            fieldManager: olds.fieldManager,
            forceConflicts: olds.forceConflicts,
            skipAwait: olds.skipAwait,
            timeoutSeconds: olds.timeoutSeconds,
            waitFor: olds.waitFor,
            deletionPropagation: olds.deletionPropagation,
            mode: olds.mode,
          },
          {
            fieldManager: news.fieldManager,
            forceConflicts: news.forceConflicts,
            skipAwait: news.skipAwait,
            timeoutSeconds: news.timeoutSeconds,
            waitFor: news.waitFor,
            deletionPropagation: news.deletionPropagation,
            mode: news.mode,
          },
        );
        if (!desiredChanged && !objectDrifted && !lifecycleChanged) {
          return { action: "noop" } as const;
        }
        if (output !== undefined && (desiredChanged || objectDrifted)) {
          const dryRun = yield* applyObject({
            transport: connected!.transport,
            object: nextDesired,
            fieldManager: fieldManagerOf(fqn, news.fieldManager),
            forceConflicts: news.forceConflicts ?? takingOwnership,
            dryRun: true,
          }).pipe(Effect.result);
          if (dryRun._tag === "Failure") {
            const error = dryRun.failure;
            if (error instanceof KubernetesApiError && error.immutable) {
              return { action: "replace", deleteFirst: true } as const;
            }
            if (
              error instanceof KubernetesApiError &&
              error.statusCode === 409
            ) {
              return yield* Effect.fail(
                new Error(
                  `Kubernetes field ownership conflict for ${nextRef.apiVersion}/${nextRef.kind} ${nextRef.namespace ?? "_cluster"}/${nextRef.name}; set forceConflicts only when this stack should take those fields`,
                ),
              );
            }
            return yield* Effect.fail(error);
          }
        }
        return { action: "update" } as const;
      }),
    reconcile: ({ fqn, instanceId, news, olds, output, session }) =>
      Effect.gen(function* () {
        const connected = yield* connectCluster(news.cluster);
        const desired = desiredObject({ props: news, fqn, instanceId });
        let applied = yield* applyObject({
          transport: connected.transport,
          object: desired,
          fieldManager: fieldManagerOf(fqn, news.fieldManager),
          forceConflicts:
            news.forceConflicts ?? (olds === undefined && output !== undefined),
        });
        const ref = refOf(applied);
        if (!(news.skipAwait ?? false)) {
          applied = yield* waitForObjectReady({
            transport: connected.transport,
            ref,
            timeoutSeconds: news.timeoutSeconds ?? 300,
            ...(news.waitFor === undefined ? {} : { waitFor: news.waitFor }),
          });
        }
        yield* session.note(
          `Applied ${ref.apiVersion}/${ref.kind} ${ref.namespace === undefined ? "" : `${ref.namespace}/`}${ref.name}`,
        );
        return attributesOf({
          connection: connected.connection,
          object: applied,
          mode: news.mode ?? "object",
        });
      }),
    delete: ({ olds, output, session }) =>
      Effect.gen(function* () {
        if (output.mode === "patch" || olds.mode === "patch") return;
        const connected = yield* connectCluster(output.connection).pipe(
          Effect.catchIf(
            (error) => error instanceof Kubernetes.ClusterNotFoundError,
            () => Effect.succeed(undefined),
          ),
        );
        if (connected === undefined) return;
        const observed = yield* readObject({
          transport: connected.transport,
          ref: output.ref,
        }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
        if (observed === undefined) return;
        if (output.uid !== undefined && observed.metadata.uid !== output.uid) {
          return yield* Effect.fail(
            new Error(
              `Refusing to delete ${output.apiVersion}/${output.kind} ${output.namespace ?? "_cluster"}/${output.name}: expected UID ${output.uid}, found ${String(observed.metadata.uid)}`,
            ),
          );
        }
        yield* deleteObject({
          transport: connected.transport,
          ref: output.ref,
          ...(output.uid === undefined ? {} : { uid: output.uid }),
          propagationPolicy: olds.deletionPropagation ?? "Foreground",
        });
        yield* waitForObjectDeleted({
          transport: connected.transport,
          ref: output.ref,
          ...(output.uid === undefined ? {} : { uid: output.uid }),
          timeoutSeconds: olds.timeoutSeconds ?? 300,
        });
        yield* session.note(
          `Deleted ${output.apiVersion}/${output.kind} ${output.namespace === undefined ? "" : `${output.namespace}/`}${output.name}`,
        );
      }),
  });

export const providers = () =>
  Layer.effect(Providers, Provider.collection([ObjectResource])).pipe(
    Layer.provide(ObjectProvider()),
    Layer.provideMerge(RandomProvider()),
  );
