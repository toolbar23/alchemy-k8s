import * as Hetzner from "alchemy/Hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  ipv4CidrRange,
  normalizeK3sDefinition,
} from "../../shared/src/definition.ts";
import { ClusterState } from "./cluster-state.ts";
import { Node } from "./node.ts";
import type { ClusterProps, NodeResource } from "./types.ts";
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

export const Cluster = (id: string, props: ClusterProps) =>
  Effect.gen(function* () {
    validateClusterProps(props);
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
    if (props.ssh.validateCurrentIp ?? true) {
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
      rules: [
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
        Hetzner.Server(`${id}-control-plane-${index + 1}`, {
          serverType: props.controlPlane.serverType,
          image: "ubuntu-24.04",
          location,
          networks: [network],
          firewalls: [firewall],
          deleteProtection: props.protectAgainstDeletion ?? true,
          labels: {
            "k3s.cluster": dnsName(id),
            "k3s.role": "server",
          },
        }),
      ),
      { concurrency: "unbounded" },
    );
    const workerServers = new Map<string, Hetzner.Server[]>();
    for (const pool of props.workerPools) {
      const servers = yield* Effect.all(
        Array.from({ length: pool.count }, (_, index) =>
          Hetzner.Server(`${id}-${pool.name}-${index + 1}`, {
            serverType: pool.serverType,
            image: "ubuntu-24.04",
            location: pool.location,
            networks: [network],
            firewalls: [firewall],
            deleteProtection: props.protectAgainstDeletion ?? true,
            labels: {
              "k3s.cluster": dnsName(id),
              "k3s.role": "agent",
              "k3s.pool": pool.name,
            },
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
      targets: controlPlaneServers.map((server) => ({
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
      ...(props.etcdSnapshots?.s3 === undefined
        ? {}
        : { s3: props.etcdSnapshots.s3 }),
    };
    const controlPlanes: NodeResource[] = [];
    for (const [index, server] of controlPlaneServers.entries()) {
      const initial = index === 0;
      const previous = controlPlanes[index - 1];
      const node = yield* Node(`${id}-control-plane-node-${index + 1}`, {
        name: dnsName(`${id}-cp-${index + 1}`),
        role: "server",
        initialServer: initial,
        server,
        ...(initial ? {} : { bootstrap: controlPlanes[0]! }),
        ...(previous === undefined ? {} : { after: previous.serverId }),
        k3s,
        networkCidr,
        apiEndpoint: apiAddress,
        scheduleWorkloadsOnControlPlane:
          props.scheduleWorkloadsOnControlPlane ?? false,
        etcdSnapshots,
      });
      controlPlanes.push(node);
    }
    const workers: NodeResource[] = [];
    for (const pool of props.workerPools) {
      let previous: NodeResource | undefined;
      for (const [index, server] of (
        workerServers.get(pool.name) ?? []
      ).entries()) {
        const node = yield* Node(`${id}-${pool.name}-node-${index + 1}`, {
          name: dnsName(`${id}-${pool.name}-${index + 1}`),
          role: "agent",
          initialServer: false,
          server,
          bootstrap: controlPlanes[0]!,
          ...(previous === undefined ? {} : { after: previous.serverId }),
          k3s,
          networkCidr,
          apiEndpoint: apiAddress,
          scheduleWorkloadsOnControlPlane: false,
          labels: { ...pool.labels, "alchemy.run/node-pool": pool.name },
          ...(pool.taints === undefined ? {} : { taints: pool.taints }),
          etcdSnapshots,
        });
        workers.push(node);
        previous = node;
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
    });
    return yield* ClusterState(id, {
      k3s,
      nodeServerIds: [...controlPlanes, ...workers].map(
        (node) => node.serverId,
      ),
      controlPlanes,
      loadBalancer,
      hcloudToken: credentials.token,
      networkName: network.name,
      networkZone,
      protectAgainstDeletion: props.protectAgainstDeletion ?? true,
      topologyFingerprint,
    });
  });
