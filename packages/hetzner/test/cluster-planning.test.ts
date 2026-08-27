import { Resource, type Resource as AlchemyResource } from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Provider from "alchemy/Provider";
import * as State from "alchemy/State";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { expect } from "vitest";
import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import { ClusterProvider, ClusterState } from "../src/cluster-state.ts";
import type {
  ClusterAttributes,
  ClusterStateProps,
  NodeReference,
} from "../src/types.ts";

type ConsumerResource = AlchemyResource<
  "Test.K3sClusterConsumer",
  { cluster: Kubernetes.ClusterLike },
  { id: string }
>;

const Consumer = Resource<ConsumerResource>("Test.K3sClusterConsumer");
const providers = Layer.mergeAll(
  ClusterProvider(),
  Provider.succeed(Consumer, {
    diff: ({ news }) =>
      Effect.sync(() => {
        Kubernetes.toConnection(
          (news as { cluster: Kubernetes.ClusterLike }).cluster,
        );
        return { action: "noop" } as const;
      }),
    reconcile: ({ output }) => Effect.succeed(output ?? { id: "consumer" }),
    delete: () => Effect.void,
  }),
);
const { test } = Test.make({ providers });

test.provider(
  "keeps the Kubernetes connection available while cluster properties update",
  (stack) =>
    Effect.gen(function* () {
      const state = yield* yield* State.State;
      const k3s = normalizeK3sDefinition({
        channel: "v1.35",
        updateWindow: {
          days: ["Sunday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "UTC",
        },
      });
      const controlPlane: NodeReference = {
        logicalName: "production-cp-1",
        name: "production-cp-1-1",
        role: "server",
        serverId: 1,
        privateIp: "10.0.0.2",
        version: "v1.35.3+k3s1",
        token: Redacted.make("token"),
        clusterId: "cluster-id",
        server: {
          id: 1,
          serverId: 1,
          name: "production-cp-1",
          ipv4: "192.0.2.1",
          privateKey: Redacted.make("private-key"),
          hostPublicKey: "ssh-ed25519 host-key",
        },
      };
      const oldProps: ClusterStateProps = {
        k3s,
        nodeServerIds: [1],
        nodeNames: [controlPlane.name],
        controlPlanes: [controlPlane],
        loadBalancer: { ipv4: "192.0.2.100" },
        hcloudToken: Redacted.make("hcloud-token"),
        networkName: "production-network",
        networkZone: "eu-central",
        protectAgainstDeletion: true,
        topologyFingerprint: "stable-topology",
        secretsEncryption: {},
        obsoleteNodeNames: [],
      };
      const connection: Kubernetes.Connection = {
        endpoint: "https://192.0.2.100:6443",
        auth: {
          kind: "kubeconfig",
          path: "/tmp/production-kubeconfig",
          context: "load-balancer",
        },
      };
      const attributes: ClusterAttributes = {
        connection,
        endpoint: connection.endpoint!,
        kubeconfigPath: "/tmp/production-kubeconfig",
        currentVersions: [
          { node: controlPlane.name, version: controlPlane.version },
        ],
        channel: "v1.35",
        topologyFingerprint: oldProps.topologyFingerprint,
        secretsEncryption: {
          enabled: true,
          provider: "secretbox",
          stage: "reencrypt_finished",
          hashesMatch: true,
        },
      };

      yield* state.set({
        stack: stack.name,
        stage: "test",
        fqn: "Cluster",
        value: {
          status: "created",
          namespace: undefined,
          fqn: "Cluster",
          logicalId: "Cluster",
          instanceId: "cluster-instance",
          resourceType: ClusterState.Type,
          providerVersion: 0,
          props: oldProps,
          attr: attributes,
          bindings: [],
          downstream: ["Consumer"],
        },
      });
      yield* state.set({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
        value: {
          status: "created",
          namespace: undefined,
          fqn: "Consumer",
          logicalId: "Consumer",
          instanceId: "consumer-instance",
          resourceType: Consumer.Type,
          providerVersion: 0,
          props: { cluster: attributes },
          attr: { id: "consumer" },
          bindings: [],
          downstream: [],
        },
      });

      const plan = yield* stack.plan(
        Effect.gen(function* () {
          const cluster = yield* ClusterState("Cluster", {
            ...oldProps,
            k3s: {
              ...k3s,
              updateWindow: { ...k3s.updateWindow, endTime: "05:00" },
            },
          });
          yield* Consumer("Consumer", { cluster });
        }),
      );

      expect(plan.resources.Cluster!.action).toBe("update");
      expect(plan.resources.Consumer!.action).toBe("noop");
      yield* state.delete({
        stack: stack.name,
        stage: "test",
        fqn: "Consumer",
      });
      yield* state.delete({ stack: stack.name, stage: "test", fqn: "Cluster" });
    }),
);
