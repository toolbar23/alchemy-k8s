import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeProps, NodeReference } from "../src/types.ts";

const remote = vi.hoisted(() => ({
  installed: new Set<number>(),
  nodes: new Set<string>(),
  k3sVersion: vi.fn(),
  remotePrivateIp: vi.fn(),
  resolveServerAccess: vi.fn(),
  ssh: vi.fn(),
  sshScript: vi.fn(),
  waitForCloudInit: vi.fn(),
  waitForSsh: vi.fn(),
}));

vi.mock("../src/remote.ts", () => remote);

type NodeMutation = import("../src/node.ts").NodeMutation;
const { Node, NodeProvider, nodeName, waitForNode } =
  await import("../src/node.ts");

const definition = normalizeK3sDefinition({
  channel: "v1.35",
  updateWindow: {
    days: ["Saturday"],
    startTime: "02:00",
    endTime: "04:00",
    timeZone: "UTC",
  },
});

const bootstrapServer = {
  id: 10,
  serverId: 10,
  name: "control-plane",
  ipv4: "192.0.2.10",
  privateKey: Redacted.make("bootstrap-private"),
  hostPublicKey: "ssh-ed25519 bootstrap-host",
};

const bootstrap: NodeReference = {
  logicalName: "control-plane",
  name: "control-plane-10",
  role: "server",
  serverId: 10,
  privateIp: "10.0.0.10",
  version: "v1.35.7+k3s1",
  token: Redacted.make("token"),
  server: bootstrapServer,
};

const oldServer = {
  id: 1,
  serverId: 1,
  name: "worker-physical",
  ipv4: "192.0.2.1",
  privateKey: Redacted.make("old-private"),
  hostPublicKey: "ssh-ed25519 old-host",
};

const newServer = {
  id: 2,
  serverId: 2,
  name: "worker-physical",
  ipv4: "192.0.2.2",
  privateKey: Redacted.make("new-private"),
  hostPublicKey: "ssh-ed25519 new-host",
};

const oldOutput: NodeReference = {
  logicalName: "worker",
  name: nodeName("worker", oldServer.serverId),
  role: "agent",
  serverId: oldServer.serverId,
  privateIp: "10.0.0.1",
  version: bootstrap.version,
  server: oldServer,
};

const news: NodeProps = {
  name: "worker",
  role: "agent",
  initialServer: false,
  bootstrapRevision: 2,
  server: newServer,
  bootstrap,
  k3s: definition,
  networkCidr: "10.0.0.0/16",
  apiEndpoint: "192.0.2.100",
  scheduleWorkloadsOnControlPlane: false,
  etcdSnapshots: { schedule: "0 * * * *", retention: 24 },
  hcloudToken: Redacted.make("hcloud"),
  privateManagement: false,
  stateId: "postgres",
  apiAuditLog: {
    enabled: true,
    maximumAgeDays: 30,
    maximumBackups: 10,
    maximumSizeMegabytes: 100,
  },
};

const olds: NodeProps = { ...news, server: oldServer };

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  remote.installed.clear();
  remote.nodes.clear();
  remote.nodes.add(oldOutput.name);
  remote.k3sVersion.mockReset();
  remote.remotePrivateIp.mockReset();
  remote.resolveServerAccess.mockReset();
  remote.ssh.mockReset();
  remote.sshScript.mockReset();
  remote.waitForCloudInit.mockReset();
  remote.waitForSsh.mockReset();

  remote.resolveServerAccess.mockImplementation(async (server) => server);
  remote.waitForSsh.mockResolvedValue(undefined);
  remote.waitForCloudInit.mockResolvedValue(undefined);
  remote.remotePrivateIp.mockResolvedValue("10.0.0.2");
  remote.k3sVersion.mockImplementation(async (server) =>
    remote.installed.has(server.serverId) ? bootstrap.version : undefined,
  );
  remote.sshScript.mockImplementation(async (server, script) => {
    if (script.includes("INSTALL_K3S_VERSION")) {
      remote.installed.add(server.serverId);
      const registeredName = /'--node-name' '([^']+)'/.exec(script)?.[1];
      if (registeredName !== undefined) remote.nodes.add(registeredName);
    }
    return "";
  });
  remote.ssh.mockImplementation(async (_server, command) => {
    const node = /(?:patch node|get node|delete node) "([^"]+)"/.exec(
      command,
    )?.[1];
    if (command.includes("kubectl patch node"))
      throw new Error("provider ID is already supplied to the kubelet");
    if (command.includes("jsonpath") && node !== undefined) {
      return remote.nodes.has(node) ? "True" : "False";
    }
    if (command.startsWith("if k3s kubectl get node") && node !== undefined) {
      remote.nodes.delete(node);
      return "";
    }
    return "";
  });
});

describe("crash-convergent K3s node replacement", () => {
  for (const failurePoint of [
    "k3s-install",
    "old-node-drain",
  ] as const satisfies readonly NodeMutation[]) {
    it(`re-observes and converges after interruption at ${failurePoint}`, async () => {
      let injected = false;
      const provider = NodeProvider({
        afterMutation: async (point) => {
          if (!injected && point === failurePoint) {
            injected = true;
            throw new Error(`injected failure after ${point}`);
          }
        },
      });
      const reconcile = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* Node.Provider;
            return yield* service.reconcile!({
              id: "worker-node-1",
              fqn: "production/worker-node-1",
              instanceId: "worker-generation",
              news,
              olds,
              output: oldOutput,
              bindings: [],
            } as never);
          }).pipe(Effect.provide(provider)),
        );

      await expect(reconcile()).rejects.toThrow("Failed to reconcile K3s node");
      const recovered = await reconcile();

      expect(recovered.serverId).toBe(newServer.serverId);
      expect(recovered.name).toBe(nodeName(news.name, newServer.serverId));
      expect(remote.installed).toContain(newServer.serverId);
      expect(remote.nodes).toEqual(new Set([recovered.name]));
    });
  }

  it("retries registration NotFound and then waits for Ready", async () => {
    vi.useFakeTimers();
    remote.ssh
      .mockRejectedValueOnce(new Error("Error from server (NotFound)"))
      .mockResolvedValueOnce("True");

    const waiting = waitForNode(bootstrapServer, "worker-2");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(waiting).resolves.toBeUndefined();
    expect(remote.ssh).toHaveBeenCalledTimes(2);
    expect(remote.ssh).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("kubectl patch node"),
    );
  });
});
