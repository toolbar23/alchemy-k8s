import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { ClusterProvider, ClusterState } from "./cluster-state.ts";
import { Machine, MachineProvider } from "./machine.ts";
import { Node, NodeProvider } from "./node.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "HetznerK3s",
) {}

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([ClusterState, Machine, Node]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(ClusterProvider(), MachineProvider(), NodeProvider()),
    ),
  );
