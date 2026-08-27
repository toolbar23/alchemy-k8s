import type { PropsInput } from "alchemy";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { ConfigGroup, type ConfigGroupResult } from "./yaml.ts";
import type { LifecycleOptions } from "./types.ts";

export interface HelmChartProps extends LifecycleOptions {
  chart: string;
  releaseName?: string;
  namespace?: string;
  repository?: string;
  version?: string;
  values?: Record<string, unknown>;
  includeCrds?: boolean;
  kubeVersion?: string;
  apiVersions?: string[];
}

export const helmTemplateArgs = (
  id: string,
  props: Omit<HelmChartProps, keyof LifecycleOptions>,
): string[] => [
  "template",
  props.releaseName ?? id.toLowerCase(),
  props.chart,
  "--skip-tests",
  "--namespace",
  props.namespace ?? "default",
  ...(props.includeCrds === false ? [] : ["--include-crds"]),
  ...(props.repository === undefined ? [] : ["--repo", props.repository]),
  ...(props.version === undefined ? [] : ["--version", props.version]),
  ...(props.kubeVersion === undefined
    ? []
    : ["--kube-version", props.kubeVersion]),
  ...(props.apiVersions ?? []).flatMap((version) => [
    "--api-versions",
    version,
  ]),
  "--values",
  "-",
];

export const renderHelmChart = (
  id: string,
  props: Omit<HelmChartProps, keyof LifecycleOptions>,
): string => {
  try {
    return execFileSync("helm", helmTemplateArgs(id, props), {
      encoding: "utf8",
      input: stringify(props.values ?? {}),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Failed to render Helm chart ${props.chart}; install helm and verify the chart reference`,
    );
  }
};

export const HelmChart = (
  id: string,
  props: PropsInput<HelmChartProps>,
): ReturnType<typeof ConfigGroup> => {
  const {
    cluster,
    dependsOn,
    fieldManager,
    forceConflicts,
    skipAwait,
    timeoutSeconds,
    waitFor,
    deletionPropagation,
    replaceOnChanges,
    ...chart
  } = props as HelmChartProps;
  const rendered = renderHelmChart(id, chart);
  return ConfigGroup(id, {
    cluster,
    yaml: rendered,
    defaultNamespace: chart.namespace ?? "default",
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(fieldManager === undefined ? {} : { fieldManager }),
    ...(forceConflicts === undefined ? {} : { forceConflicts }),
    ...(skipAwait === undefined ? {} : { skipAwait }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(waitFor === undefined ? {} : { waitFor }),
    ...(deletionPropagation === undefined ? {} : { deletionPropagation }),
    ...(replaceOnChanges === undefined ? {} : { replaceOnChanges }),
  }) as ReturnType<typeof ConfigGroup> &
    import("effect/Effect").Effect<ConfigGroupResult, never, never>;
};
