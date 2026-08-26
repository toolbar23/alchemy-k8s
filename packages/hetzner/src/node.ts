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
  resolveServerAccess,
  ssh,
  sshScript,
  waitForCloudInit,
  waitForSsh,
} from "./remote.ts";
import {
  assertSafeRestoreVersion,
  buildRecoveryScript,
  k3sS3Arguments,
  listRemoteEtcdSnapshots,
  selectRecoverySnapshot,
} from "./recovery.ts";
import type {
  NodeProps,
  NodeReference,
  NodeResource,
  ServerReference,
} from "./types.ts";

export const Node = Resource<NodeResource>("Hetzner.K3s.Node");

export const K3S_INSTALL_COMMIT = "33c19246e5c14cac5a4d839b2b8d5773f7173f46";
export const K3S_INSTALL_SHA256 =
  "ed01f89fd977bf20ac1516bbebf8370bf3ddbaa55dac8aba610956a4c78cc00b";

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
      "--flannel-backend",
      props.k3s.flannelBackend,
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
    if (props.apiAuditLog.enabled) {
      args.push(
        "--kube-apiserver-arg",
        "audit-policy-file=/etc/rancher/k3s/audit-policy.yaml",
        "--kube-apiserver-arg",
        "audit-log-path=/var/lib/rancher/k3s/server/logs/audit.log",
        "--kube-apiserver-arg",
        `audit-log-maxage=${props.apiAuditLog.maximumAgeDays}`,
        "--kube-apiserver-arg",
        `audit-log-maxbackup=${props.apiAuditLog.maximumBackups}`,
        "--kube-apiserver-arg",
        `audit-log-maxsize=${props.apiAuditLog.maximumSizeMegabytes}`,
      );
    }
  }
  const backup = props.etcdSnapshots.s3;
  if (props.role === "server" && backup !== undefined) {
    args.push(
      ...k3sS3Arguments(
        backup,
        props.etcdSnapshots.folder,
        props.etcdSnapshots.retention,
      ),
    );
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
  skipStart = false,
): string => {
  const token =
    props.bootstrap?.token === undefined
      ? undefined
      : secretValue(props.bootstrap.token);
  const values: Record<string, string> = {
    INSTALL_K3S_VERSION: desiredVersion,
  };
  if (props.role === "agent" || skipStart)
    values.INSTALL_K3S_SKIP_START = "true";
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
${
  props.role === "server" && props.apiAuditLog.enabled
    ? `install -d -m 0700 /etc/rancher/k3s /var/lib/rancher/k3s/server/logs
cat > /etc/rancher/k3s/audit-policy.yaml <<'ALCHEMY_AUDIT_POLICY'
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: ["RequestReceived"]
rules:
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
  - level: None
    resources:
      - group: ""
        resources: ["events"]
  - level: Metadata
ALCHEMY_AUDIT_POLICY
`
    : ""
}private_interface=$(ip -o -4 addr show | awk -v address=${shellQuote(privateIp)} 'index($4, address "/") == 1 { print $2; exit }')
if [ -z "$private_interface" ]; then
  echo "Unable to find the interface for private IP ${privateIp}" >&2
  exit 1
fi
install_script=$(mktemp)
trap 'rm -f "$install_script"' EXIT
curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 120 \
  ${shellQuote(`https://raw.githubusercontent.com/k3s-io/k3s/${K3S_INSTALL_COMMIT}/install.sh`)} \
  -o "$install_script"
printf '%s  %s\n' ${shellQuote(K3S_INSTALL_SHA256)} "$install_script" | sha256sum --check --status
${environment} sh "$install_script" ${args} '--flannel-iface' "$private_interface"
${props.role === "agent" && !skipStart ? "systemctl restart --no-block k3s-agent\n" : ""}
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
  const server = await resolveServerAccess(
    props.server,
    props.networkCidr,
    props.hcloudToken,
    props.privateManagement,
  );
  const version = await k3sVersion(server);
  if (version === undefined) return undefined;
  const privateIp = await remotePrivateIp(server, props.networkCidr);
  const token = props.initialServer
    ? Redacted.make(
        await ssh(server, "cat /var/lib/rancher/k3s/server/node-token"),
      )
    : undefined;
  const clusterId = props.initialServer
    ? await ssh(
        server,
        "k3s kubectl get namespace kube-system -o jsonpath='{.metadata.uid}'",
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
    ...(clusterId === undefined ? {} : { clusterId }),
    server,
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
    read: ({ olds, output }) =>
      Effect.tryPromise({
        try: async () => {
          if (olds.server === undefined) return output;
          let observed: NodeReference | undefined;
          try {
            observed = await observe(olds);
          } catch (error) {
            // Pre-hardening state has no pinned host key, so it cannot be
            // inspected safely. Preserve that state just long enough for the
            // create-first server replacement to reconcile every legacy node.
            if (
              output !== undefined &&
              (olds.initialServer || olds.server.hostPublicKey === undefined)
            ) {
              return output;
            }
            throw error;
          }
          // The persisted initial token and cluster ID are the recovery root.
          // Never reinterpret an unreachable old control plane as greenfield.
          if (observed === undefined && olds.initialServer) return output;
          if (observed === undefined) return undefined;
          return {
            ...observed,
            ...(output?.obsoleteNodeName === undefined
              ? {}
              : { obsoleteNodeName: output.obsoleteNodeName }),
            ...(output?.recovery === undefined
              ? {}
              : { recovery: output.recovery }),
          };
        },
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
          const restoringInitial = replacingServer && news.initialServer;
          if (restoringInitial) {
            assertSameMinor(output.version, desiredVersion);
            if (
              news.recovery?.restoreOnInitialControlPlaneReplacement !== true
            ) {
              throw new Error(
                "Replacing the initial control-plane server requires recovery.restoreOnInitialControlPlaneReplacement",
              );
            }
            if (news.stateId !== "postgres") {
              throw new Error(
                `Automatic recovery requires Alchemy's locked Postgres state backend; received ${JSON.stringify(news.stateId)}`,
              );
            }
            if (
              output?.token === undefined ||
              news.etcdSnapshots.s3 === undefined
            ) {
              throw new Error(
                "Automatic recovery requires the original server token and S3 snapshot access in encrypted state",
              );
            }
            assertSafeRestoreVersion(desiredVersion);
          }
          const server = await resolveServerAccess(
            news.server,
            news.networkCidr,
            news.hcloudToken,
            news.privateManagement,
          );
          await waitForSsh(server);
          await waitForCloudInit(server);
          if (
            news.initialServer &&
            olds !== undefined &&
            olds.k3s.channel !== news.k3s.channel
          ) {
            await ssh(
              server,
              "k3s kubectl delete plan -n system-upgrade k3s-agent k3s-server --ignore-not-found",
            );
          }
          const privateIp = await remotePrivateIp(server, news.networkCidr);
          const desiredName = nodeName(news.name, news.server.serverId);
          const effectiveNews = { ...news, name: desiredName, server };
          const installedVersion = await k3sVersion(server);
          if (
            installedVersion !== undefined &&
            olds?.k3s.channel === news.k3s.channel
          ) {
            assertSameMinor(installedVersion, desiredVersion);
          }
          if (
            news.initialServer &&
            installedVersion !== undefined &&
            news.secretsEncryption !== undefined &&
            !restoringInitial
          ) {
            await prepareExistingClusterEncryption(
              server,
              installedVersion,
              desiredVersion,
              news.secretsEncryption.migrateExisting,
              news.secretsEncryption.failureInjection,
            );
          }
          const bootstrapReplaced =
            !news.initialServer &&
            news.role === "server" &&
            installedVersion !== undefined &&
            olds?.bootstrap?.serverId !== undefined &&
            olds.bootstrap.serverId !== news.bootstrap?.serverId;
          if (bootstrapReplaced) {
            await sshScript(
              server,
              `set -euo pipefail
systemctl stop k3s
if [ -d /var/lib/rancher/k3s/server/db ]; then
  mv /var/lib/rancher/k3s/server/db /var/lib/rancher/k3s/server/db.alchemy-pre-rejoin-$(date +%s)
fi
`,
            );
          }
          await sshScript(
            server,
            buildInstallScript(
              effectiveNews,
              privateIp,
              desiredVersion,
              restoringInitial,
            ),
            15 * 60_000,
          );
          let recovery:
            | {
                restoredSnapshot: string;
                snapshotCreatedAt: string;
                completedAt: string;
              }
            | undefined;
          if (restoringInitial) {
            const token = Redacted.value(output!.token!);
            const snapshots = await listRemoteEtcdSnapshots(
              news.etcdSnapshots.s3!,
              news.etcdSnapshots.folder,
            );
            const selected = selectRecoverySnapshot(
              snapshots,
              output!.clusterId,
              token,
              news.recovery!.maximumSnapshotAge,
            );
            await sshScript(
              server,
              buildRecoveryScript(
                selected,
                token,
                news.etcdSnapshots.s3!,
                news.etcdSnapshots.folder,
                news.etcdSnapshots.retention,
                news.recovery!,
              ),
              30 * 60_000,
            );
            recovery = {
              restoredSnapshot: selected.name,
              snapshotCreatedAt: selected.createdAt.toISOString(),
              completedAt: new Date().toISOString(),
            };
          }
          const admin = news.initialServer ? server : news.bootstrap!.server;
          await ssh(admin, providerIdPatchCommand(desiredName, news.server.id));
          await waitForNode(admin, desiredName);
          if (news.role === "server") {
            const encryption = await inspectSecretsEncryption(server);
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
          if (replacingServer && output !== undefined && !restoringInitial) {
            await drainNode(admin, output.name);
          }
          const token = news.initialServer
            ? Redacted.make(
                await ssh(server, "cat /var/lib/rancher/k3s/server/node-token"),
              )
            : undefined;
          const clusterId = news.initialServer
            ? await ssh(
                server,
                "k3s kubectl get namespace kube-system -o jsonpath='{.metadata.uid}'",
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
            ...(clusterId === undefined ? {} : { clusterId }),
            ...(restoringInitial && output !== undefined
              ? { obsoleteNodeName: output.name }
              : {}),
            ...(recovery === undefined ? {} : { recovery }),
            server,
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
