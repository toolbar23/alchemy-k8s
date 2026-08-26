import { Resource } from "alchemy";
import { isResolved } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import { assertSameMinor } from "../../shared/src/definition.ts";
import { resolveChannelVersion } from "../../shared/src/channel.ts";
import {
  inspectSecretsEncryption,
  prepareExistingClusterEncryption,
  secretsEncryptionArguments,
  supportsSecretbox,
} from "./secrets-encryption.ts";
import {
  k3sVersion,
  remotePrivateIp,
  ssh,
  sshScript,
  waitForSsh,
} from "./remote.ts";
import type {
  NodeProps,
  NodeReference,
  NodeResource,
  ServerReference,
} from "./types.ts";

export const Node = Resource<NodeResource>("Hetzner.K3s.Node");

const secretValue = (value: Redacted.Redacted<string>): string =>
  Redacted.value(value);

const shellQuote = (value: string): string => {
  const escaped = value.replaceAll("'", `'"'"'`);
  return `'${escaped}'`;
};

export const nodeName = (logicalName: string, serverId: number): string => {
  const suffix = `-${serverId}`;
  return `${logicalName.slice(0, 63 - suffix.length).replace(/-$/g, "")}${suffix}`;
};

export const providerIdPatchCommand = (
  name: string,
  serverId: number,
): string => {
  const payload = JSON.stringify({
    spec: { providerID: `hcloud://${serverId}` },
  });
  return `k3s kubectl patch node ${JSON.stringify(name)} --type=merge -p ${JSON.stringify(payload)}`;
};

const installArguments = (
  props: NodeProps,
  privateIp: string,
  token: string | undefined,
  desiredVersion: string,
): string[] => {
  const args = [
    props.role === "server" ? "server" : "agent",
    "--node-name",
    props.name,
    "--node-ip",
    privateIp,
    "--kubelet-arg",
    "cloud-provider=external",
    "--kubelet-arg",
    `provider-id=hcloud://${props.server.serverId}`,
  ];
  if (props.initialServer) {
    args.push(
      "--cluster-init",
      "--cluster-cidr",
      props.k3s.clusterCidr,
      "--service-cidr",
      props.k3s.serviceCidr,
      "--cluster-dns",
      props.k3s.clusterDns,
      "--disable-cloud-controller",
      "--disable",
      "servicelb",
      "--disable",
      "local-storage",
      "--etcd-snapshot-schedule-cron",
      props.etcdSnapshots.schedule,
      "--etcd-snapshot-retention",
      String(props.etcdSnapshots.retention),
    );
    if (!props.k3s.addons.traefik) args.push("--disable", "traefik");
    if (!props.k3s.addons.metricsServer)
      args.push("--disable", "metrics-server");
    if (!props.scheduleWorkloadsOnControlPlane) {
      args.push(
        "--node-taint",
        "node-role.kubernetes.io/control-plane=true:NoSchedule",
      );
    }
  } else if (props.role === "server") {
    args.push(
      "--disable-cloud-controller",
      "--etcd-snapshot-schedule-cron",
      props.etcdSnapshots.schedule,
      "--etcd-snapshot-retention",
      String(props.etcdSnapshots.retention),
    );
    if (!props.scheduleWorkloadsOnControlPlane) {
      args.push(
        "--node-taint",
        "node-role.kubernetes.io/control-plane=true:NoSchedule",
      );
    }
  }
  if (props.role === "server") {
    args.push(
      ...secretsEncryptionArguments(desiredVersion),
      "--tls-san",
      props.apiEndpoint,
    );
    if (props.server.ipv4 !== undefined) {
      args.push("--tls-san", props.server.ipv4);
    }
  }
  const backup = props.etcdSnapshots.s3;
  if (props.role === "server" && backup !== undefined) {
    args.push(
      "--etcd-s3",
      "--etcd-s3-endpoint",
      backup.endpoint,
      "--etcd-s3-region",
      backup.region,
      "--etcd-s3-bucket",
      backup.bucket,
      "--etcd-s3-access-key",
      secretValue(backup.accessKey),
      "--etcd-s3-secret-key",
      secretValue(backup.secretKey),
      "--etcd-s3-retention",
      String(props.etcdSnapshots.retention),
    );
    if (backup.folder !== undefined)
      args.push("--etcd-s3-folder", backup.folder);
    if (backup.forcePathStyle)
      args.push("--etcd-s3-bucket-lookup-type", "path");
  }
  for (const [key, value] of Object.entries(props.labels ?? {})) {
    args.push("--node-label", `${key}=${value}`);
  }
  for (const taint of props.taints ?? []) args.push("--node-taint", taint);
  if (!props.initialServer && token === undefined) {
    throw new Error(`Node ${props.name} has no bootstrap token`);
  }
  return args;
};

export const buildInstallScript = (
  props: NodeProps,
  privateIp: string,
  desiredVersion: string,
): string => {
  const token =
    props.bootstrap?.token === undefined
      ? undefined
      : secretValue(props.bootstrap.token);
  const values: Record<string, string> = {
    INSTALL_K3S_VERSION: desiredVersion,
  };
  if (!props.initialServer) {
    values.K3S_URL = `https://${props.bootstrap!.privateIp}:6443`;
    values.K3S_TOKEN = token!;
  }
  const environment = Object.entries(values)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const args = installArguments(props, privateIp, token, desiredVersion)
    .map(shellQuote)
    .join(" ");
  return `set -euo pipefail
private_interface=$(ip -o -4 addr show | awk -v address=${shellQuote(privateIp)} 'index($4, address "/") == 1 { print $2; exit }')
if [ -z "$private_interface" ]; then
  echo "Unable to find the interface for private IP ${privateIp}" >&2
  exit 1
fi
curl -sfL https://get.k3s.io | ${environment} sh -s - ${args} '--flannel-iface' "$private_interface"
`;
};

const waitForNode = async (
  admin: ServerReference,
  name: string,
): Promise<void> => {
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await ssh(
        admin,
        `k3s kubectl get node ${JSON.stringify(name)} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`,
      );
      if (last === "True") return;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Timed out waiting for Kubernetes node ${name}; last result: ${last}`,
  );
};

const drainNode = async (
  admin: ServerReference,
  name: string,
): Promise<void> => {
  await ssh(
    admin,
    `k3s kubectl drain ${JSON.stringify(name)} --ignore-daemonsets --delete-emptydir-data --timeout=10m && k3s kubectl delete node ${JSON.stringify(name)} --ignore-not-found`,
    12 * 60_000,
  );
};

const observe = async (
  props: NodeProps,
): Promise<NodeReference | undefined> => {
  const version = await k3sVersion(props.server);
  if (version === undefined) return undefined;
  const privateIp = await remotePrivateIp(props.server, props.networkCidr);
  const token = props.initialServer
    ? Redacted.make(
        await ssh(props.server, "cat /var/lib/rancher/k3s/server/node-token"),
      )
    : undefined;
  return {
    logicalName: props.name,
    name: nodeName(props.name, props.server.serverId),
    role: props.role,
    serverId: props.server.serverId,
    privateIp,
    version,
    ...(token === undefined ? {} : { token }),
    server: props.server,
  };
};

export const createNodeReconcileLimiter = () => {
  const clusterSemaphores = new Map<string, Semaphore.Semaphore>();
  return <A, E, R>(
    cluster: string,
    serialize: boolean,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    if (!serialize) return operation;
    let semaphore = clusterSemaphores.get(cluster);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(1);
      clusterSemaphores.set(cluster, semaphore);
    }
    return semaphore.withPermit(operation);
  };
};

export const NodeProvider = () => {
  const limitReconcile = createNodeReconcileLimiter();
  return Provider.succeed(Node, {
    stables: ["logicalName", "role"],
    read: ({ olds }) =>
      Effect.tryPromise({
        try: () => observe(olds),
        catch: (cause) =>
          new Error(`Unable to inspect K3s node ${olds.name}`, { cause }),
      }),
    diff: ({ news, output }) =>
      Effect.sync(() => {
        if (!isResolved(news)) return undefined;
        if (output !== undefined) {
          if (
            typeof news.name === "string" &&
            news.name !== output.logicalName
          ) {
            throw new Error("K3s node names are immutable");
          }
          if (typeof news.role === "string" && news.role !== output.role) {
            throw new Error("Changing a K3s node role is not supported");
          }
        }
        return undefined;
      }),
    reconcile: ({ news, olds, output }) => {
      const operation = Effect.tryPromise({
        try: async () => {
          const desiredVersion = news.initialServer
            ? await resolveChannelVersion(news.k3s.channel)
            : news.bootstrap!.version;
          if (output !== undefined && olds?.k3s.channel === news.k3s.channel) {
            assertSameMinor(output.version, desiredVersion);
          }
          const replacingServer =
            output !== undefined && output.serverId !== news.server.serverId;
          if (replacingServer && news.initialServer) {
            throw new Error(
              "Replacing the initial control-plane server is not supported in v1; create a new cluster or restore a snapshot",
            );
          }
          await waitForSsh(news.server);
          if (
            news.initialServer &&
            olds !== undefined &&
            olds.k3s.channel !== news.k3s.channel
          ) {
            await ssh(
              news.server,
              "k3s kubectl delete plan -n system-upgrade k3s-agent k3s-server --ignore-not-found",
            );
          }
          const privateIp = await remotePrivateIp(
            news.server,
            news.networkCidr,
          );
          const desiredName = nodeName(news.name, news.server.serverId);
          const effectiveNews = { ...news, name: desiredName };
          const installedVersion = await k3sVersion(news.server);
          if (
            installedVersion !== undefined &&
            olds?.k3s.channel === news.k3s.channel
          ) {
            assertSameMinor(installedVersion, desiredVersion);
          }
          if (
            news.initialServer &&
            installedVersion !== undefined &&
            news.secretsEncryption !== undefined
          ) {
            await prepareExistingClusterEncryption(
              news.server,
              installedVersion,
              desiredVersion,
              news.secretsEncryption.migrateExisting,
              news.secretsEncryption.failureInjection,
            );
          }
          await sshScript(
            news.server,
            buildInstallScript(effectiveNews, privateIp, desiredVersion),
            15 * 60_000,
          );
          const admin = news.initialServer
            ? news.server
            : news.bootstrap!.server;
          await ssh(admin, providerIdPatchCommand(desiredName, news.server.id));
          await waitForNode(admin, desiredName);
          if (news.role === "server") {
            const encryption = await inspectSecretsEncryption(news.server);
            const migrationPending =
              news.secretsEncryption?.migrateExisting === true &&
              ((!encryption.enabled && encryption.stage === "start") ||
                (encryption.enabled && encryption.provider === "aescbc"));
            if (!encryption.enabled && !migrationPending) {
              throw new Error(
                `K3s Secret encryption is not enabled on ${desiredName}`,
              );
            }
            if (
              encryption.enabled &&
              !migrationPending &&
              supportsSecretbox(desiredVersion) &&
              encryption.provider !== "secretbox"
            ) {
              throw new Error(
                `K3s Secret encryption on ${desiredName} is not using secretbox`,
              );
            }
          }
          if (replacingServer && output !== undefined) {
            await drainNode(admin, output.name);
          }
          const token = news.initialServer
            ? Redacted.make(
                await ssh(
                  news.server,
                  "cat /var/lib/rancher/k3s/server/node-token",
                ),
              )
            : undefined;
          return {
            logicalName: news.name,
            name: desiredName,
            role: news.role,
            serverId: news.server.serverId,
            privateIp,
            version: desiredVersion,
            ...(token === undefined ? {} : { token }),
            server: news.server,
          };
        },
        catch: (cause) =>
          new Error(`Failed to reconcile K3s node ${news.name}`, { cause }),
      });
      return limitReconcile(
        news.apiEndpoint,
        output !== undefined && !news.initialServer,
        operation,
      );
    },
    delete: ({ olds, output }) =>
      Effect.tryPromise({
        try: async () => {
          if (!olds.initialServer && olds.bootstrap !== undefined) {
            await drainNode(olds.bootstrap.server, output.name).catch(
              () => undefined,
            );
          }
          const uninstall =
            output.role === "server"
              ? "k3s-uninstall.sh"
              : "k3s-agent-uninstall.sh";
          await ssh(
            output.server,
            `command -v ${uninstall} >/dev/null && ${uninstall} || true`,
            10 * 60_000,
          ).catch(() => undefined);
        },
        catch: (cause) =>
          new Error(`Failed to remove K3s node ${output.name}`, { cause }),
      }),
  });
};
