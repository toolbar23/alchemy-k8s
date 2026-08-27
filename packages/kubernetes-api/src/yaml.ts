import type { Input, PropsInput } from "alchemy";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { Object as KubernetesObjectResource } from "./resource.ts";
import type {
  KubernetesObject,
  LifecycleOptions,
  ObjectResource,
} from "./types.ts";

export interface ConfigGroupProps extends LifecycleOptions {
  objects?: KubernetesObject[];
  yaml?: string | string[];
  files?: string[];
  defaultNamespace?: string;
}

export interface ConfigGroupResult {
  resources: ObjectResource[];
  objects: KubernetesObject[];
}

const clusterScopedKinds = new Set([
  "CustomResourceDefinition",
  "Namespace",
  "Node",
  "PersistentVolume",
  "ClusterRole",
  "ClusterRoleBinding",
  "IngressClass",
  "StorageClass",
  "CSIDriver",
  "CSINode",
  "VolumeAttachment",
  "VolumeAttributesClass",
]);

const applyRank = (object: KubernetesObject): number => {
  if (object.kind === "Namespace") return 10;
  if (object.kind === "CustomResourceDefinition") return 20;
  if (["ServiceAccount", "ClusterRole", "Role"].includes(object.kind)) {
    return 30;
  }
  if (["ClusterRoleBinding", "RoleBinding"].includes(object.kind)) return 40;
  if (["ConfigMap", "Service", "PersistentVolumeClaim"].includes(object.kind)) {
    return 50;
  }
  return 100;
};

export const parseKubernetesYaml = (source: string): KubernetesObject[] =>
  parseAllDocuments(source).flatMap((document) => {
    if (document.errors.length > 0) {
      throw new Error(
        `Invalid Kubernetes YAML: ${document.errors[0]!.message}`,
      );
    }
    const value = document.toJS() as unknown;
    if (value === null || value === undefined) return [];
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Every Kubernetes YAML document must be an object");
    }
    const object = value as KubernetesObject;
    if (object.kind === "List") {
      const items = (object as unknown as { items?: unknown[] }).items;
      if (!Array.isArray(items)) {
        throw new Error("Kubernetes List YAML requires an items array");
      }
      return items as KubernetesObject[];
    }
    return [object];
  });

export const normalizeConfigGroupObjects = (
  props: Omit<ConfigGroupProps, keyof LifecycleOptions>,
): KubernetesObject[] => {
  const yamlSources = [
    ...(typeof props.yaml === "string" ? [props.yaml] : (props.yaml ?? [])),
    ...(props.files ?? []).map((file) => readFileSync(file, "utf8")),
  ];
  const objects = [
    ...(props.objects ?? []),
    ...yamlSources.flatMap(parseKubernetesYaml),
  ].map((object) => {
    if (
      props.defaultNamespace === undefined ||
      clusterScopedKinds.has(object.kind) ||
      object.metadata?.namespace !== undefined
    ) {
      return object;
    }
    return {
      ...object,
      metadata: { ...object.metadata, namespace: props.defaultNamespace },
    };
  });
  for (const object of objects) {
    if (
      typeof object.apiVersion !== "string" ||
      typeof object.kind !== "string" ||
      typeof object.metadata?.name !== "string"
    ) {
      throw new Error(
        "Every ConfigGroup object requires apiVersion, kind, and metadata.name",
      );
    }
    if (object.kind === "Secret") {
      throw new Error(
        "ConfigGroup refuses Kubernetes Secret documents; use KubernetesAddons.Secret",
      );
    }
  }
  return objects.sort(
    (left, right) =>
      applyRank(left) - applyRank(right) ||
      `${left.apiVersion}/${left.kind}/${left.metadata.namespace ?? ""}/${left.metadata.name}`.localeCompare(
        `${right.apiVersion}/${right.kind}/${right.metadata.namespace ?? ""}/${right.metadata.name}`,
      ),
  );
};

export const ConfigGroup = (
  id: string,
  props: PropsInput<ConfigGroupProps>,
): Effect.Effect<
  ConfigGroupResult,
  never,
  import("./providers.ts").Providers
> =>
  Effect.gen(function* () {
    const {
      cluster,
      objects,
      yaml,
      files,
      defaultNamespace,
      dependsOn,
      ...lifecycle
    } = props as ConfigGroupProps;
    const normalized = normalizeConfigGroupObjects({
      ...(objects === undefined ? {} : { objects }),
      ...(yaml === undefined ? {} : { yaml }),
      ...(files === undefined ? {} : { files }),
      ...(defaultNamespace === undefined ? {} : { defaultNamespace }),
    });
    const resources: ObjectResource[] = [];
    let dependency: Input<string | undefined> = dependsOn;
    const usedIds = new Map<string, number>();
    for (const object of normalized) {
      const baseId = `${id}${object.kind}${object.metadata.name}`.replace(
        /[^A-Za-z0-9_-]/g,
        "_",
      );
      const count = usedIds.get(baseId) ?? 0;
      usedIds.set(baseId, count + 1);
      const logicalId = count === 0 ? baseId : `${baseId}_${String(count + 1)}`;
      const resource: ObjectResource = yield* KubernetesObjectResource(
        logicalId,
        {
          cluster,
          manifest: object,
          ...lifecycle,
          ...(dependency === undefined ? {} : { dependsOn: dependency }),
        },
      );
      resources.push(resource);
      dependency = resource.resourceVersion;
    }
    return { resources, objects: normalized };
  });
