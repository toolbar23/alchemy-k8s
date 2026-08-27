import type { Effect } from "effect/Effect";
import { expect, it } from "vitest";
import { apps, core, type ObjectInstance } from "../src/index.ts";

declare const cluster: {
  auth: { kind: "kubeconfig"; context: string };
};

const acceptsTypedStatefulSet = (
  _resource: Effect<
    ObjectInstance<
      import("kubernetes-models/apps/v1/StatefulSet").IStatefulSet
    >,
    never,
    any
  >,
): void => undefined;

const compileTypeFixtures = () => {
  const statefulSet = apps.v1.StatefulSet("Database", {
    cluster,
    metadata: { name: "database", namespace: "apps" },
    spec: {
      serviceName: "database",
      selector: { matchLabels: { app: "database" } },
      template: {
        metadata: { labels: { app: "database" } },
        spec: { containers: [{ name: "db", image: "postgres:18" }] },
      },
    },
  });
  acceptsTypedStatefulSet(statefulSet);

  apps.v1.StatefulSet("InvalidDatabase", {
    cluster,
    metadata: { name: "database", namespace: "apps" },
    spec: {
      // @ts-expect-error replicas is generated as a number
      replicas: "three",
      serviceName: "database",
      selector: { matchLabels: { app: "database" } },
      template: {
        metadata: { labels: { app: "database" } },
        spec: { containers: [{ name: "db", image: "postgres:18" }] },
      },
    },
  });

  // @ts-expect-error Secret is deliberately write-only through KubernetesAddons.Secret
  void core.v1.Secret;
};

void compileTypeFixtures;

it("keeps generated constructor type fixtures compiled", () => {
  expect(apps.v1.StatefulSet).toBeTypeOf("function");
});
