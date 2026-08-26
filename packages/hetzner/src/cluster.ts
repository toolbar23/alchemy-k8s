import * as Hetzner from "alchemy/Hetzner";
import * as Output from "alchemy/Output";
import { Stage, makeRandom } from "alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import {
  ipv4CidrRange,
  normalizeK3sDefinition,
} from "../../shared/src/definition.ts";
import { ClusterState } from "./cluster-state.ts";
import { hardenedCloudInit, hostIdentity } from "./hardening.ts";
import { Node } from "./node.ts";
import type { Providers } from "./providers.ts";
import type { ClusterProps, ClusterResource, NodeResource } from "./types.ts";
import {
  networkZoneFor,
  normalizeLocations,
  validateClusterProps,
  validateCurrentRunnerIp,
} from "./validation.ts";

const dnsName = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (normalized.length === 0)
    throw new Error("Cluster id must contain a letter or number");
  return normalized.slice(0, 63).replace(/-$/g, "");
};

export const productionStateWarning = (
  stage: string,
  stateId: string,
  nodeEnvironment = process.env.NODE_ENV,
  encryptionAtRestConfirmed = false,
): string | undefined => {
  const production =
    nodeEnvironment === "production" ||
    /(^|[-_])(prod|production)([-_]|$)/i.test(stage);
  const knownEncrypted = stateId === "cloudflare-http" || stateId === "s3";
  if (production && (knownEncrypted || encryptionAtRestConfirmed)) {
    return undefined;
  }
  if (!production) {
    return undefined;
  }
  return `Production stage ${JSON.stringify(stage)} uses Alchemy state ${JSON.stringify(stateId)} without confirmed encryption at rest. Redacted Hetzner, K3s, SSH, backup, and add-on credentials require an encrypted remote state backend.`;
};

export const Cluster = (id: string, props: ClusterProps) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const state = yield* yield* State;
    const stateWarning = productionStateWarning(
      stage,
      state.id,
      process.env.NODE_ENV,
      props.state?.encryptionAtRestConfirmed ?? false,
    );
    if (stateWarning !== undefined) throw new Error(stateWarning);
    validateClusterProps(props);
    if (props.recovery !== undefined && state.id !== "postgres") {
      throw new Error(
        `Automatic control-plane recovery requires Alchemy's locked Postgres state backend; received ${JSON.stringify(state.id)}`,
      );
    }
    if (
      props.recovery !== undefined &&
      props.state?.encryptionAtRestConfirmed !== true
    ) {
      throw new Error(
        "Automatic recovery requires state.encryptionAtRestConfirmed: true for the locked Postgres state backend",
      );
    }
    const k3s = normalizeK3sDefinition(props.k3s);
    const locations = normalizeLocations(props);
    const networkZone = networkZoneFor(locations);
    const networkCidr = props.networkCidr ?? "10.0.0.0/16";
    const networkRange = ipv4CidrRange(networkCidr);
    if (networkRange === undefined) {
      throw new Error("networkCidr must be an IPv4 CIDR");
    }
    for (const kubernetesCidr of [k3s.clusterCidr, k3s.serviceCidr]) {
      const kubernetesRange = ipv4CidrRange(kubernetesCidr)!;
      if (
        networkRange[0] <= kubernetesRange[1] &&
        kubernetesRange[0] <= networkRange[1]
      ) {
        throw new Error(
          `networkCidr must not overlap Kubernetes CIDR ${kubernetesCidr}`,
        );
      }
    }
    const privateManagement = props.ssh.privateOnly ?? false;
    if (!privateManagement && (props.ssh.validateCurrentIp ?? true)) {
      yield* Effect.promise(() =>
        validateCurrentRunnerIp(props.ssh.allowedCidrs),
      );
    }
    const resolveCredentials = yield* Hetzner.Credentials;
    const credentials = yield* resolveCredentials;
    const network = yield* Hetzner.Network(`${id}-network`, {
      ipRange: networkCidr,
      subnets: [{ type: "cloud", ipRange: networkCidr, networkZone }],
      deleteProtection: props.protectAgainstDeletion ?? true,
      labels: { "k3s.cluster": dnsName(id) },
    });
    const firewall = yield* Hetzner.Firewall(`${id}-firewall`, {
      rules: privateManagement
        ? []
        : [
            {
              description: "Alchemy deploy access",
              direction: "in",
              protocol: "tcp",
              port: "22",
              sourceIps: props.ssh.allowedCidrs,
            },
            {
              description: "ICMP diagnostics",
              direction: "in",
              protocol: "icmp",
              sourceIps: props.ssh.allowedCidrs,
            },
            {
              description: "Direct Kubernetes API fallback",
              direction: "in",
              protocol: "tcp",
              port: "6443",
              sourceIps: props.ssh.allowedCidrs,
            },
          ],
      labels: { "k3s.cluster": dnsName(id) },
    });
    const controlPlaneServers = yield* Effect.all(
      locations.map((location, index) =>
        Effect.gen(function* () {
          const seed = yield* makeRandom(
            `${id}-control-plane-${index + 1}-host-key`,
          );
          const identity = Output.map(seed, (value) =>
            hostIdentity(value, `${dnsName(id)}-cp-${index + 1}`),
          );
          const replacementToken =
            index === 0 ? props.recovery?.replacementToken : undefined;
          const server = yield* Hetzner.Server(
            `${id}-control-plane-${index + 1}`,
            {
              serverType: props.controlPlane.serverType,
              image: "ubuntu-24.04",
              // The public address supplies outbound internet; its inbound
              // firewall is empty when management is private-only.
              enableIpv4: true,
              enableIpv6: false,
              userData: Output.map(identity, (resolved) =>
                hardenedCloudInit(resolved, replacementToken),
              ),
              location,
              networks: [network],
              firewalls: [firewall],
              deleteProtection: props.protectAgainstDeletion ?? true,
              labels: {
                "k3s.cluster": dnsName(id),
                "k3s.role": "server",
              },
            },
          );
          return {
            server,
            reference: Output.map(
              Output.all(Output.of(server), identity),
              ([resolved, host]) => ({
                ...resolved,
                hostPublicKey: host.publicKey,
              }),
            ),
          };
        }),
      ),
      { concurrency: "unbounded" },
    );
    const workerServers = new Map<string, typeof controlPlaneServers>();
    for (const pool of props.workerPools) {
      const servers = yield* Effect.all(
        Array.from({ length: pool.count }, (_, index) =>
          Effect.gen(function* () {
            const seed = yield* makeRandom(
              `${id}-${pool.name}-${index + 1}-host-key`,
            );
            const identity = Output.map(seed, (value) =>
              hostIdentity(value, `${dnsName(id)}-${pool.name}-${index + 1}`),
            );
            const server = yield* Hetzner.Server(
              `${id}-${pool.name}-${index + 1}`,
              {
                serverType: pool.serverType,
                image: "ubuntu-24.04",
                enableIpv4: true,
                enableIpv6: false,
                userData: Output.map(identity, (resolved) =>
                  hardenedCloudInit(resolved, pool.replacementToken),
                ),
                location: pool.location,
                networks: [network],
                firewalls: [firewall],
                deleteProtection: props.protectAgainstDeletion ?? true,
                labels: {
                  "k3s.cluster": dnsName(id),
                  "k3s.role": "agent",
                  "k3s.pool": pool.name,
                },
              },
            );
            return {
              server,
              reference: Output.map(
                Output.all(Output.of(server), identity),
                ([resolved, host]) => ({
                  ...resolved,
                  hostPublicKey: host.publicKey,
                }),
              ),
            };
          }),
        ),
        { concurrency: "unbounded" },
      );
      workerServers.set(pool.name, servers);
    }
    const loadBalancer = yield* Hetzner.LoadBalancer(`${id}-api`, {
      loadBalancerType: props.apiLoadBalancer?.type ?? "lb11",
      location: props.apiLoadBalancer?.location ?? locations[0]!,
      networks: [network],
      targets: controlPlaneServers.map(({ server }) => ({
        type: "server" as const,
        server,
        usePrivateIp: true,
      })),
      services: [
        {
          protocol: "tcp",
          listenPort: 6443,
          destinationPort: 6443,
          healthCheck: { protocol: "tcp", port: 6443 },
        },
      ],
      deleteProtection: props.protectAgainstDeletion ?? true,
      labels: { "k3s.cluster": dnsName(id) },
    });
    const apiAddress = loadBalancer.ipv4.pipe(
      Output.map((address) => {
        if (address === null)
          throw new Error("Hetzner API load balancer has no IPv4");
        return address;
      }),
    );
    const etcdSnapshots = {
      schedule: props.etcdSnapshots?.schedule ?? "0 * * * *",
      retention: props.etcdSnapshots?.retention ?? 24,
      ...(props.etcdSnapshots?.folder === undefined
        ? {}
        : { folder: props.etcdSnapshots.folder }),
      ...(props.etcdSnapshots?.s3 === undefined
        ? {}
        : { s3: props.etcdSnapshots.s3 }),
    };
    const secretsEncryption = {
      migrateExisting: props.secretsEncryption?.migrateExisting ?? false,
      ...(props.secretsEncryption?.failureInjection === undefined
        ? {}
        : {
            failureInjection: props.secretsEncryption.failureInjection,
          }),
      ...(props.secretsEncryption?.keyRotationToken === undefined
        ? {}
        : { keyRotationToken: props.secretsEncryption.keyRotationToken }),
    };
    const apiAuditLog = {
      enabled: props.apiAuditLog?.enabled ?? true,
      maximumAgeDays: props.apiAuditLog?.maximumAgeDays ?? 30,
      maximumBackups: props.apiAuditLog?.maximumBackups ?? 10,
      maximumSizeMegabytes: props.apiAuditLog?.maximumSizeMegabytes ?? 100,
    };
    const controlPlanes: NodeResource[] = [];
    for (const [
      index,
      { reference: server },
    ] of controlPlaneServers.entries()) {
      const initial = index === 0;
      const node = yield* Node(`${id}-control-plane-node-${index + 1}`, {
        name: dnsName(`${id}-cp-${index + 1}`),
        role: "server",
        initialServer: initial,
        bootstrapRevision: 3,
        server,
        ...(initial ? {} : { bootstrap: controlPlanes[0]! }),
        k3s,
        networkCidr,
        apiEndpoint: apiAddress,
        scheduleWorkloadsOnControlPlane:
          props.scheduleWorkloadsOnControlPlane ?? false,
        etcdSnapshots,
        hcloudToken: credentials.token,
        privateManagement,
        stateId: state.id,
        ...(props.recovery === undefined ? {} : { recovery: props.recovery }),
        apiAuditLog,
        secretsEncryption,
      });
      controlPlanes.push(node);
    }
    const workers: NodeResource[] = [];
    for (const pool of props.workerPools) {
      for (const [index, { reference: server }] of (
        workerServers.get(pool.name) ?? []
      ).entries()) {
        const node = yield* Node(`${id}-${pool.name}-node-${index + 1}`, {
          name: dnsName(`${id}-${pool.name}-${index + 1}`),
          role: "agent",
          initialServer: false,
          bootstrapRevision: 2,
          server,
          bootstrap: controlPlanes[0]!,
          k3s,
          networkCidr,
          apiEndpoint: apiAddress,
          scheduleWorkloadsOnControlPlane: false,
          labels: { ...pool.labels, "alchemy.run/node-pool": pool.name },
          ...(pool.taints === undefined ? {} : { taints: pool.taints }),
          etcdSnapshots,
          hcloudToken: credentials.token,
          privateManagement,
          stateId: state.id,
          apiAuditLog,
        });
        workers.push(node);
      }
    }
    const topologyFingerprint = JSON.stringify({
      controlPlane: {
        count: props.controlPlane.count,
        serverType: props.controlPlane.serverType,
        locations,
      },
      networkCidr,
      clusterCidr: k3s.clusterCidr,
      serviceCidr: k3s.serviceCidr,
      clusterDns: k3s.clusterDns,
      flannelBackend: k3s.flannelBackend,
      privateManagement,
    });
    return yield* ClusterState(id, {
      k3s,
      nodeServerIds: [...controlPlanes, ...workers].map(
        (node) => node.serverId,
      ),
      nodeNames: [...controlPlanes, ...workers].map((node) => node.name),
      controlPlanes,
      loadBalancer,
      hcloudToken: credentials.token,
      networkName: network.name,
      networkZone,
      protectAgainstDeletion: props.protectAgainstDeletion ?? true,
      topologyFingerprint,
      obsoleteNodeNames: Output.map(
        Output.all(...controlPlanes.map((node) => node.obsoleteNodeName)).as<
          Array<string | undefined>
        >(),
        (names) => names.filter((name): name is string => name !== undefined),
      ),
      secretsEncryption: {
        ...(secretsEncryption.failureInjection === undefined
          ? {}
          : { failureInjection: secretsEncryption.failureInjection }),
        ...(secretsEncryption.keyRotationToken === undefined
          ? {}
          : { keyRotationToken: secretsEncryption.keyRotationToken }),
      },
    });
  }) as Effect.Effect<
    ClusterResource,
    never,
    Providers | Hetzner.Providers | Stage
  >;
