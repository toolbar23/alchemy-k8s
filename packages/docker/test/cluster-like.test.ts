import type { Input } from "alchemy";
import type * as Kubernetes from "alchemy/Kubernetes";
import { expect, it } from "vitest";
import type { ClusterResource } from "../src/types.ts";

const acceptsCluster = (_cluster: Input<Kubernetes.ClusterLike>): void =>
  undefined;

const compileClusterLike = (cluster: ClusterResource): void =>
  acceptsCluster(cluster);
void compileClusterLike;

it("is statically compatible with a Kubernetes ClusterLike input", () => {
  expect(true).toBe(true);
});
