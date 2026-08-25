import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { ClusterProvider, ClusterState } from "./cluster-state.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "DockerK3s",
) {}

export const providers = () =>
  Layer.effect(Providers, Provider.collection([ClusterState])).pipe(
    Layer.provide(ClusterProvider()),
  );
