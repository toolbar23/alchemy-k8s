import type { PropsInput, Resource as AlchemyResource } from "alchemy";
import type * as Kubernetes from "alchemy/Kubernetes";
import type { Providers } from "./providers.ts";

export interface ObjectMetadata {
  name: string;
  namespace?: string | undefined;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  uid?: string | undefined;
  resourceVersion?: string | undefined;
  generation?: number | undefined;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  managedFields?: unknown[];
  finalizers?: string[];
  [key: string]: unknown;
}

export interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata: ObjectMetadata;
  spec?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

export interface ObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string | undefined;
}

export type DeletionPropagation = "Foreground" | "Background" | "Orphan";

export type WaitFor =
  | { condition: string; status?: "True" | "False" | "Unknown" }
  | { jsonPath: string; equals: unknown };

export interface LifecycleOptions {
  cluster: Kubernetes.ClusterLike;
  /** Establishes an Alchemy graph dependency without adding a manifest field. */
  dependsOn?: string | undefined;
  fieldManager?: string;
  forceConflicts?: boolean;
  skipAwait?: boolean;
  timeoutSeconds?: number;
  waitFor?: WaitFor;
  deletionPropagation?: DeletionPropagation;
  replaceOnChanges?: string[];
}

type ServerMetadataKeys =
  | "uid"
  | "resourceVersion"
  | "generation"
  | "creationTimestamp"
  | "deletionTimestamp"
  | "deletionGracePeriodSeconds"
  | "managedFields"
  | "selfLink";

type DesiredMetadata<T> = Omit<NonNullable<T>, ServerMetadataKeys | "name"> & {
  name: string;
  namespace?: string;
};

export type DesiredObject<T> = T extends {
  metadata?: infer M;
}
  ? Omit<T, "apiVersion" | "kind" | "status" | "metadata"> & {
      metadata: DesiredMetadata<M>;
    }
  : Omit<T, "apiVersion" | "kind" | "status"> & {
      metadata: { name: string; namespace?: string };
    };

export type BuiltinProps<T> = LifecycleOptions & DesiredObject<T>;

export interface ObjectProps extends Omit<LifecycleOptions, "dependsOn"> {
  manifest: KubernetesObject;
  mode?: "object" | "patch";
}

export interface ObjectDependencyBinding {
  dependency: string | undefined;
}

type Field<T, K extends PropertyKey> = K extends keyof T ? T[K] : undefined;

export interface ObjectAttributes<T = KubernetesObject> {
  connection: Kubernetes.Connection;
  ref: ObjectRef;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | undefined;
  uid: string | undefined;
  resourceVersion: string | undefined;
  generation: number | undefined;
  metadata: Field<T, "metadata">;
  spec: Field<T, "spec">;
  status: Field<T, "status">;
  live: T;
  mode: "object" | "patch";
}

export type ObjectResource<T = KubernetesObject> = AlchemyResource<
  "KubernetesApi.Object",
  ObjectProps,
  ObjectAttributes<T>,
  ObjectDependencyBinding,
  Providers
>;

export type BuiltinConstructor<T> = (
  id: string,
  props: PropsInput<BuiltinProps<T>>,
) => import("effect/Effect").Effect<ObjectResource<T>, never, Providers>;
