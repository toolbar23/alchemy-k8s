import { isResolved, Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import type * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { parse } from "yaml";
import { resolveChannelVersion } from "../../shared/src/channel.ts";
import {
  assertSameMinor,
  isInsideUpdateWindow,
} from "../../shared/src/definition.ts";
import {
  kubeconfigPath,
  writeKubeconfig,
} from "../../shared/src/kubeconfig.ts";
import {
  createK3dCluster,
  deleteK3dCluster,
  getKubeconfig,
  inspectK3dCluster,
  requireK3d,
  runningVersion,
} from "./k3d.ts";
import type {
  ClusterAttributes,
  ClusterResource,
  ClusterStateProps,
} from "./types.ts";

export const ClusterState = Resource<ClusterResource>("Docker.K3s.Cluster");

const observe = async (
  fqn: string,
  props: ClusterStateProps,
): Promise<ClusterAttributes | undefined> => {
  await requireK3d();
  const cluster = await inspectK3dCluster(props);
  if (cluster === undefined) return undefined;
  const kubeconfig = await getKubeconfig(props);
  const parsed = parse(kubeconfig) as {
    "current-context"?: string;
    clusters?: Array<{ cluster?: { server?: string } }>;
  };
  const target = parsed.clusters?.[0]?.cluster?.server;
  if (target === undefined)
    throw new Error("k3d returned a kubeconfig without an API endpoint");
  const path = kubeconfigPath("docker", fqn);
  await writeKubeconfig(path, kubeconfig);
  const version = await runningVersion(props, cluster);
  if (cluster.clusterToken === undefined || cluster.clusterToken.length === 0) {
    throw new Error("k3d returned no cluster token");
  }
  return {
    connection: {
      endpoint: target,
      auth: {
        kind: "kubeconfig",
        path,
        ...(parsed["current-context"] === undefined
          ? {}
          : { context: parsed["current-context"] }),
      },
    } satisfies Kubernetes.Connection,
    endpoint: target,
    kubeconfigPath: path,
    currentVersions: [{ node: `${props.name}-server-0`, version }],
    currentVersion: version,
    channel: props.k3s.channel,
    name: props.name,
    volumeName: props.volume.name,
    token: Redacted.make(cluster.clusterToken),
    configFingerprint: props.configFingerprint,
  };
};

export const ClusterProvider = () =>
  Provider.succeed(ClusterState, {
    stables: ["name", "volumeName", "kubeconfigPath"],
    read: ({ fqn, olds }) =>
      Effect.tryPromise({
        try: () => observe(fqn, olds),
        catch: (cause) =>
          new Error(`Unable to inspect local K3s cluster ${olds.name}`, {
            cause,
          }),
      }),
    diff: ({ news, olds, output }) =>
      Effect.tryPromise({
        try: async () => {
          if (output === undefined) return undefined;
          if (!isResolved(news)) return undefined;
          if (typeof news.name === "string" && news.name !== output.name) {
            return { action: "replace" as const, deleteFirst: true };
          }
          if (
            typeof news.configFingerprint === "string" &&
            news.configFingerprint !== output.configFingerprint
          ) {
            return { action: "update" as const };
          }
          if (typeof news.k3s !== "object" || !("channel" in news.k3s))
            return undefined;
          const desired = await resolveChannelVersion(
            news.k3s.channel as string,
          );
          if (news.k3s.channel === olds.k3s.channel) {
            assertSameMinor(output.currentVersion, desired);
          }
          if (output.currentVersion === desired)
            return { action: "noop" as const };
          if (
            !isInsideUpdateWindow(
              news.k3s.updateWindow as ClusterStateProps["k3s"]["updateWindow"],
            )
          ) {
            console.warn(
              `K3s ${desired} is available for ${output.name}; update deferred until the configured maintenance window`,
            );
            return { action: "noop" as const };
          }
          return { action: "update" as const };
        },
        catch: (cause) =>
          new Error("Unable to plan local K3s update", { cause }),
      }),
    reconcile: ({ fqn, news, olds, output }) =>
      Effect.tryPromise({
        try: async () => {
          await requireK3d();
          const desired = await resolveChannelVersion(news.k3s.channel);
          if (output !== undefined && olds?.k3s.channel === news.k3s.channel) {
            assertSameMinor(output.currentVersion, desired);
          }
          const existing = await inspectK3dCluster(news);
          const recreate =
            existing !== undefined &&
            ((await runningVersion(news, existing)) !== desired ||
              output?.configFingerprint !== news.configFingerprint);
          if (recreate) await deleteK3dCluster(news);
          if (existing === undefined || recreate) {
            await createK3dCluster(
              news,
              desired,
              output === undefined ? undefined : Redacted.value(output.token),
            );
          }
          const observed = await observe(fqn, news);
          if (observed === undefined)
            throw new Error("k3d cluster was not visible after creation");
          return observed;
        },
        catch: (cause) =>
          new Error(`Failed to reconcile local K3s cluster ${news.name}`, {
            cause,
          }),
      }),
    delete: ({ olds }) =>
      Effect.tryPromise({
        try: async () => {
          if ((await inspectK3dCluster(olds)) !== undefined)
            await deleteK3dCluster(olds);
        },
        catch: (cause) =>
          new Error(`Failed to delete local K3s cluster ${olds.name}`, {
            cause,
          }),
      }),
  });
