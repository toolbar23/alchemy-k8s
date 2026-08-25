import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import type * as Kubernetes from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { parse, stringify } from "yaml";
import {
  kubeconfigPath,
  writeKubeconfig,
} from "../../shared/src/kubeconfig.ts";
import type { ClusterVersion } from "../../shared/src/types.ts";
import {
  CSI_MANIFEST,
  SYSTEM_UPGRADE_CONTROLLER_MANIFEST,
  hccmManifest,
  systemUpgradePlans,
} from "./manifests.ts";
import { k3sVersion, ssh, sshScript } from "./remote.ts";
import type {
  ClusterAttributes,
  ClusterResource,
  ClusterStateProps,
  NodeReference,
} from "./types.ts";

export const ClusterState = Resource<ClusterResource>("Hetzner.K3s.Cluster");

interface KubeconfigDocument {
  apiVersion: string;
  kind: string;
  clusters: Array<{ name: string; cluster: Record<string, unknown> }>;
  users: Array<{ name: string; user: Record<string, unknown> }>;
  contexts: Array<{ name: string; context: { cluster: string; user: string } }>;
  "current-context": string;
}

const admin = (props: ClusterStateProps): NodeReference => {
  const node = props.controlPlanes[0];
  if (node === undefined) throw new Error("Cluster has no control-plane node");
  return node;
};

const endpoint = (props: ClusterStateProps): string => {
  if (props.loadBalancer.ipv4 === null)
    throw new Error("Hetzner API load balancer has no IPv4");
  return `https://${props.loadBalancer.ipv4}:6443`;
};

const addonScript = (props: ClusterStateProps): string => {
  const token = Redacted.value(props.hcloudToken);
  const tokenBase64 = Buffer.from(token).toString("base64");
  const networkBase64 = Buffer.from(props.networkName).toString("base64");
  const hcloudSecret = Buffer.from(
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: hcloud\n  namespace: kube-system\ntype: Opaque\ndata:\n  token: ${tokenBase64}\n  network: ${networkBase64}\n`,
  ).toString("base64");
  const csiSecret = Buffer.from(
    `apiVersion: v1\nkind: Secret\nmetadata:\n  name: hcloud-csi\n  namespace: kube-system\ntype: Opaque\ndata:\n  token: ${tokenBase64}\n`,
  ).toString("base64");
  const plans = Buffer.from(systemUpgradePlans(props.k3s)).toString("base64");
  return `set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
printf %s ${JSON.stringify(hcloudSecret)} | base64 -d | kubectl apply -f -
kubectl apply -f ${JSON.stringify(hccmManifest(props.k3s.channel))}
kubectl -n kube-system set env deployment/hcloud-cloud-controller-manager HCLOUD_LOAD_BALANCERS_NETWORK_ZONE=${JSON.stringify(props.networkZone)} HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP=true
printf %s ${JSON.stringify(csiSecret)} | base64 -d | kubectl apply -f -
kubectl apply -f ${JSON.stringify(CSI_MANIFEST)}
kubectl apply -f ${JSON.stringify(SYSTEM_UPGRADE_CONTROLLER_MANIFEST)}
printf %s ${JSON.stringify(plans)} | base64 -d | kubectl apply -f -
kubectl -n kube-system rollout status deployment/hcloud-cloud-controller-manager --timeout=5m
kubectl -n kube-system rollout status deployment/hcloud-csi-controller --timeout=5m
`;
};

const renderKubeconfig = (
  source: string,
  props: ClusterStateProps,
): { contents: string; context: string } => {
  const parsed = parse(source) as KubeconfigDocument;
  const baseCluster = parsed.clusters[0]?.cluster;
  const baseUser = parsed.users[0]?.user;
  if (baseCluster === undefined || baseUser === undefined) {
    throw new Error("K3s returned an invalid kubeconfig");
  }
  const contexts = [
    { name: "load-balancer", server: endpoint(props) },
    ...props.controlPlanes.map((node) => ({
      name: node.name,
      server: `https://${node.server.ipv4}:6443`,
    })),
  ];
  const document: KubeconfigDocument = {
    apiVersion: "v1",
    kind: "Config",
    clusters: contexts.map(({ name, server }) => ({
      name,
      cluster: { ...baseCluster, server },
    })),
    users: [{ name: "admin", user: baseUser }],
    contexts: contexts.map(({ name }) => ({
      name,
      context: { cluster: name, user: "admin" },
    })),
    "current-context": "load-balancer",
  };
  return { contents: stringify(document), context: "load-balancer" };
};

const inspectVersions = async (
  props: ClusterStateProps,
): Promise<ClusterVersion[]> => {
  const output = await ssh(
    admin(props).server,
    "k3s kubectl get nodes -o json",
  );
  const document = JSON.parse(output) as {
    items: Array<{
      metadata: { name: string };
      spec?: { unschedulable?: boolean };
      status?: { nodeInfo?: { kubeletVersion?: string } };
    }>;
  };
  const cordoned = document.items
    .filter((item) => item.spec?.unschedulable)
    .map((item) => item.metadata.name);
  if (cordoned.length > 0) {
    console.warn(`K3s update status: cordoned node(s): ${cordoned.join(", ")}`);
  }
  const versions = document.items.map((item) => ({
    node: item.metadata.name,
    version: item.status?.nodeInfo?.kubeletVersion ?? "unknown",
  }));
  if (new Set(versions.map(({ version }) => version)).size > 1) {
    console.warn(
      "K3s update status: cluster currently has mixed node versions",
    );
  }
  const failed = await ssh(
    admin(props).server,
    "k3s kubectl get jobs -n system-upgrade -o json 2>/dev/null || printf '{\"items\":[]}'",
  );
  const failedJobs = (
    JSON.parse(failed) as {
      items: Array<{
        metadata: { name: string };
        status?: { failed?: number };
      }>;
    }
  ).items
    .filter((job) => (job.status?.failed ?? 0) > 0)
    .map((job) => job.metadata.name);
  if (failedJobs.length > 0) {
    console.warn(
      `K3s update status: failed System Upgrade jobs: ${failedJobs.join(", ")}`,
    );
  }
  return versions;
};

const observe = async (
  fqn: string,
  props: ClusterStateProps,
): Promise<ClusterAttributes | undefined> => {
  if ((await k3sVersion(admin(props).server)) === undefined) return undefined;
  const source = await ssh(
    admin(props).server,
    "cat /etc/rancher/k3s/k3s.yaml",
  );
  const rendered = renderKubeconfig(source, props);
  const path = kubeconfigPath("hetzner", fqn);
  await writeKubeconfig(path, rendered.contents);
  const target = endpoint(props);
  return {
    connection: {
      endpoint: target,
      auth: { kind: "kubeconfig", path, context: rendered.context },
    } satisfies Kubernetes.Connection,
    endpoint: target,
    kubeconfigPath: path,
    currentVersions: await inspectVersions(props),
    channel: props.k3s.channel,
    topologyFingerprint: props.topologyFingerprint,
  };
};

export const ClusterProvider = () =>
  Provider.succeed(ClusterState, {
    stables: ["kubeconfigPath", "topologyFingerprint"],
    read: ({ fqn, olds }) =>
      Effect.tryPromise({
        try: () => observe(fqn, olds),
        catch: (cause) =>
          new Error("Unable to inspect Hetzner K3s cluster", { cause }),
      }),
    diff: ({ news, output }) =>
      Effect.sync(() => {
        const fingerprint = (news as { topologyFingerprint?: unknown })
          .topologyFingerprint;
        if (
          output !== undefined &&
          typeof fingerprint === "string" &&
          fingerprint !== output.topologyFingerprint
        ) {
          throw new Error(
            "Control-plane topology, locations, server type, and cluster CIDRs are immutable in v1; create a new cluster for this change",
          );
        }
        return undefined;
      }),
    reconcile: ({ fqn, news }) =>
      Effect.tryPromise({
        try: async () => {
          await sshScript(admin(news).server, addonScript(news), 15 * 60_000);
          const observed = await observe(fqn, news);
          if (observed === undefined)
            throw new Error("Cluster disappeared after add-on installation");
          return observed;
        },
        catch: (cause) =>
          new Error("Failed to configure Hetzner K3s cluster", { cause }),
      }),
    delete: ({ olds }) =>
      Effect.tryPromise({
        try: async () => {
          if (olds.protectAgainstDeletion) {
            throw new Error(
              "Cluster deletion is protected. Deploy protectAgainstDeletion: false before destroying it.",
            );
          }
          await ssh(
            admin(olds).server,
            "k3s kubectl delete plan -n system-upgrade k3s-agent k3s-server --ignore-not-found",
          ).catch(() => undefined);
        },
        catch: (cause) =>
          new Error("Failed to prepare Hetzner K3s cluster deletion", {
            cause,
          }),
      }),
  });
