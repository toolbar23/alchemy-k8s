import * as Docker from "alchemy/Docker";
import * as Effect from "effect/Effect";
import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import { ClusterState } from "./cluster-state.ts";
import type { ClusterProps } from "./types.ts";

const clusterName = (id: string): string => {
  const name = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (name.length === 0)
    throw new Error("Cluster id must contain a letter or number");
  return name;
};

const validPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65535;

export const Cluster = (id: string, props: ClusterProps) =>
  Effect.gen(function* () {
    const k3s = normalizeK3sDefinition(props.k3s);
    if (props.apiPort !== undefined && !validPort(props.apiPort)) {
      throw new Error("apiPort must be an integer between 1 and 65535");
    }
    for (const mapping of props.ports ?? []) {
      if (!validPort(mapping.hostPort) || !validPort(mapping.containerPort)) {
        throw new Error(
          "Every local port mapping must use ports between 1 and 65535",
        );
      }
    }
    const volume = yield* Docker.Volume(`${id}-data`, {
      ...(props.context === undefined ? {} : { context: props.context }),
      labels: { "k3s.cluster": clusterName(id) },
    });
    const ports = props.ports ?? [];
    return yield* ClusterState(id, {
      name: clusterName(id),
      k3s,
      ...(props.context === undefined ? {} : { context: props.context }),
      ...(props.apiPort === undefined ? {} : { apiPort: props.apiPort }),
      ports,
      volume,
      configFingerprint: JSON.stringify({
        apiPort: props.apiPort,
        ports,
        clusterCidr: k3s.clusterCidr,
        serviceCidr: k3s.serviceCidr,
        clusterDns: k3s.clusterDns,
        addons: k3s.addons,
      }),
    });
  });
