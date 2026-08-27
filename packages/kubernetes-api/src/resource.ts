import { Resource, type PropsInput } from "alchemy";
import * as Effect from "effect/Effect";
import type {
  BuiltinConstructor,
  BuiltinProps,
  KubernetesObject,
  LifecycleOptions,
  ObjectDependencyBinding,
  ObjectProps,
  ObjectResource as ObjectResourceInstance,
} from "./types.ts";

export const ObjectResource = Resource<ObjectResourceInstance>(
  "KubernetesApi.Object",
);

type GenericObjectProps<T extends KubernetesObject> = LifecycleOptions & {
  manifest: T;
};

export const Object = <T extends KubernetesObject = KubernetesObject>(
  id: string,
  props: PropsInput<GenericObjectProps<T>>,
) => {
  const { dependsOn, ...resourceProps } = props as PropsInput<
    GenericObjectProps<T>
  >;
  return registerObject(
    id,
    resourceProps as PropsInput<ObjectProps>,
    dependsOn,
  ) as unknown as Effect.Effect<
    ObjectResourceInstance<T>,
    never,
    import("./providers.ts").Providers
  >;
};

const lifecycleKeys = new Set([
  "cluster",
  "fieldManager",
  "forceConflicts",
  "skipAwait",
  "timeoutSeconds",
  "waitFor",
  "deletionPropagation",
  "replaceOnChanges",
]);

const toObjectProps = (
  apiVersion: string,
  kind: string,
  props: Record<string, unknown>,
  mode: "object" | "patch",
): ObjectProps => {
  const lifecycle: Record<string, unknown> = {};
  const manifest: Record<string, unknown> = { apiVersion, kind };
  for (const [key, value] of globalThis.Object.entries(props)) {
    if (key === "dependsOn") continue;
    (lifecycleKeys.has(key) ? lifecycle : manifest)[key] = value;
  }
  return { ...lifecycle, manifest, mode } as unknown as ObjectProps;
};

const registerObject = (
  id: string,
  props: PropsInput<ObjectProps>,
  dependency: PropsInput<ObjectDependencyBinding>["dependency"],
) => {
  const resource = ObjectResource(id, props);
  return dependency === undefined
    ? resource
    : Effect.tap(resource, (registered) =>
        registered.bind("dependsOn", { dependency }),
      );
};

export const defineBuiltin = <T>(
  apiVersion: string,
  kind: string,
): BuiltinConstructor<T> =>
  ((id: string, props: PropsInput<BuiltinProps<T>>) =>
    registerObject(
      id,
      toObjectProps(
        apiVersion,
        kind,
        props as Record<string, unknown>,
        "object",
      ) as PropsInput<ObjectProps>,
      (
        props as {
          dependsOn?: PropsInput<ObjectDependencyBinding>["dependency"];
        }
      ).dependsOn,
    )) as unknown as BuiltinConstructor<T>;

export const definePatch = <T>(
  apiVersion: string,
  kind: string,
): BuiltinConstructor<T> =>
  ((id: string, props: PropsInput<BuiltinProps<T>>) =>
    registerObject(
      id,
      toObjectProps(
        apiVersion,
        kind,
        props as Record<string, unknown>,
        "patch",
      ) as PropsInput<ObjectProps>,
      (
        props as {
          dependsOn?: PropsInput<ObjectDependencyBinding>["dependency"];
        }
      ).dependsOn,
    )) as unknown as BuiltinConstructor<T>;
