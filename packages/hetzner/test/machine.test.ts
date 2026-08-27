import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import {
  HcloudRequestError,
  deleteMachine,
  diffMachine,
  reconcileMachine,
  type CloudServer,
  type MachineCloud,
  type MachineMutation,
} from "../src/machine.ts";
import type { MachineAttributes, MachineProps } from "../src/types.ts";

const identity = {
  name: "production-worker-a1b2c3",
  labels: {
    "alchemy.stack": "production",
    "alchemy.stage": "production",
    "alchemy.id": "worker-1",
    "k3s.cluster": "production",
    "k3s.generation": "00112233445566778899aabbccddeeff",
  },
};

const props: MachineProps = {
  generation: "machine-generation-1",
  name: identity.name,
  credentials: {
    token: Redacted.make("token"),
    apiBaseUrl: "https://api.hetzner.cloud/v1",
  },
  serverType: "cx23",
  image: "ubuntu-24.04",
  location: "nbg1",
  sshKey: { id: 7 },
  network: { networkId: 10 },
  firewall: { id: 20 },
  userData: "#cloud-config\n",
  enableIpv4: true,
  enableIpv6: false,
  deleteProtection: true,
  labels: { "k3s.cluster": "production" },
};

const server = (overrides: Partial<CloudServer> = {}): CloudServer => ({
  id: 1,
  name: identity.name,
  status: "running",
  server_type: { id: 23, name: props.serverType },
  image: { id: 24, name: props.image },
  location: { id: 1, name: props.location },
  public_net: {
    ipv4: { ip: "203.0.113.10" },
    ipv6: null,
    firewalls: [{ id: props.firewall.id }],
  },
  private_net: [{ network: props.network.networkId }],
  protection: { delete: props.deleteProtection },
  created: "2026-08-27T08:00:00Z",
  labels: { ...identity.labels },
  ...overrides,
});

const attributes = (value: CloudServer): MachineAttributes => ({
  id: value.id,
  serverId: value.id,
  name: value.name,
  status: value.status,
  serverType: value.server_type.name,
  serverTypeId: value.server_type.id,
  image: value.image?.name ?? undefined,
  imageId: value.image?.id,
  location: value.location.name,
  locationId: value.location.id,
  ipv4: value.public_net.ipv4?.ip,
  ipv6: value.public_net.ipv6?.ip,
  networkIds: value.private_net.map(({ network }) => network),
  firewallIds: value.public_net.firewalls.map(({ id }) => id),
  deleteProtection: value.protection.delete,
  created: value.created,
  labels: { ...value.labels },
});

class FakeMachineCloud implements MachineCloud {
  readonly servers = new Map<number, CloudServer>();
  readonly mutations: MachineMutation[] = [];
  createCount = 0;
  nextId = 1;

  seed(value: CloudServer): MachineAttributes {
    this.servers.set(value.id, value);
    this.nextId = Math.max(this.nextId, value.id + 1);
    return attributes(value);
  }

  async getServer(id: number): Promise<CloudServer | undefined> {
    return this.servers.get(id);
  }

  async findServer(name: string): Promise<CloudServer | undefined> {
    return [...this.servers.values()].find((value) => value.name === name);
  }

  async createServer(input: {
    name: string;
    props: MachineProps;
    labels: Record<string, string>;
  }): Promise<{ server: CloudServer; actionIds: number[] }> {
    if (await this.findServer(input.name)) {
      throw new HcloudRequestError(409, "conflict", "name already exists");
    }
    this.createCount += 1;
    const created = server({
      id: this.nextId++,
      name: input.name,
      server_type: { id: 23, name: input.props.serverType },
      image: { id: 24, name: input.props.image },
      location: { id: 1, name: input.props.location },
      public_net: {
        ipv4: input.props.enableIpv4 ? { ip: "203.0.113.10" } : null,
        ipv6: input.props.enableIpv6 ? { ip: "2001:db8::1" } : null,
        firewalls: [{ id: input.props.firewall.id }],
      },
      private_net: [{ network: input.props.network.networkId }],
      protection: { delete: false },
      labels: { ...input.labels },
    });
    this.servers.set(created.id, created);
    this.mutations.push("server-create");
    return { server: created, actionIds: [] };
  }

  async updateMetadata(
    id: number,
    name: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const current = this.required(id);
    current.name = name;
    current.labels = { ...labels };
    this.mutations.push("metadata-update");
  }

  async powerOn(id: number) {
    this.required(id).status = "running";
    this.mutations.push("server-power-on");
    return { actionIds: [] };
  }

  async changeProtection(id: number, enabled: boolean) {
    this.required(id).protection.delete = enabled;
    this.mutations.push(enabled ? "protection-change" : "server-unprotect");
    return { actionIds: [] };
  }

  async attachNetwork(id: number, networkId: number) {
    this.required(id).private_net.push({ network: networkId });
    this.mutations.push("network-attach");
    return { actionIds: [] };
  }

  async detachNetwork(id: number, networkId: number) {
    const current = this.required(id);
    current.private_net = current.private_net.filter(
      ({ network }) => network !== networkId,
    );
    this.mutations.push("network-detach");
    return { actionIds: [] };
  }

  async applyFirewall(id: number, firewallId: number) {
    this.required(id).public_net.firewalls.push({ id: firewallId });
    this.mutations.push("firewall-apply");
    return { actionIds: [] };
  }

  async removeFirewall(id: number, firewallId: number) {
    const current = this.required(id);
    current.public_net.firewalls = current.public_net.firewalls.filter(
      ({ id: observed }) => observed !== firewallId,
    );
    this.mutations.push("firewall-remove");
    return { actionIds: [] };
  }

  async deleteServer(id: number) {
    this.servers.delete(id);
    this.mutations.push("server-delete");
    return { actionIds: [] };
  }

  async waitForActions(): Promise<void> {}

  async waitForReady(id: number): Promise<CloudServer> {
    return this.required(id);
  }

  async waitForGone(id: number): Promise<void> {
    if (this.servers.has(id)) throw new Error(`Server ${id} still exists`);
  }

  private required(id: number): CloudServer {
    const current = this.servers.get(id);
    if (current === undefined) throw new Error(`Missing fake server ${id}`);
    return current;
  }
}

const assertConverged = (
  cloud: FakeMachineCloud,
  output: MachineAttributes,
) => {
  expect(cloud.servers.size).toBe(1);
  const current = cloud.servers.get(output.id)!;
  expect(current.name).toBe(identity.name);
  expect(current.labels).toEqual(identity.labels);
  expect(current.private_net).toEqual([{ network: props.network.networkId }]);
  expect(current.public_net.firewalls).toEqual([{ id: props.firewall.id }]);
  expect(current.protection.delete).toBe(true);
};

describe("crash-convergent Hetzner machines", () => {
  const reconcileCases: Array<{
    mutation: MachineMutation;
    initial?: CloudServer;
  }> = [
    { mutation: "server-create" },
    {
      mutation: "server-power-on",
      initial: server({ status: "off" }),
    },
    {
      mutation: "metadata-update",
      initial: server({ labels: { ...identity.labels, drift: "true" } }),
    },
    {
      mutation: "network-detach",
      initial: server({ private_net: [{ network: 99 }] }),
    },
    { mutation: "network-attach", initial: server({ private_net: [] }) },
    {
      mutation: "firewall-remove",
      initial: server({
        public_net: {
          ipv4: { ip: "203.0.113.10" },
          ipv6: null,
          firewalls: [{ id: 99 }],
        },
      }),
    },
    {
      mutation: "firewall-apply",
      initial: server({
        public_net: {
          ipv4: { ip: "203.0.113.10" },
          ipv6: null,
          firewalls: [],
        },
      }),
    },
    {
      mutation: "protection-change",
      initial: server({ protection: { delete: false } }),
    },
  ];

  for (const { mutation, initial } of reconcileCases) {
    it(`converges without duplicates after interruption at ${mutation}`, async () => {
      const cloud = new FakeMachineCloud();
      const oldOutput = initial === undefined ? undefined : cloud.seed(initial);
      let injected = false;

      await expect(
        reconcileMachine(cloud, identity, props, oldOutput, async (point) => {
          if (!injected && point === mutation) {
            injected = true;
            throw new Error(`injected failure after ${point}`);
          }
        }),
      ).rejects.toThrow(`injected failure after ${mutation}`);

      const recovered = await reconcileMachine(
        cloud,
        identity,
        props,
        oldOutput,
      );
      assertConverged(cloud, recovered);
      const mutationsAfterRecovery = cloud.mutations.length;

      const stable = await reconcileMachine(cloud, identity, props, recovered);
      assertConverged(cloud, stable);
      expect(cloud.mutations).toHaveLength(mutationsAfterRecovery);
      expect(
        cloud.mutations.filter((point) => point === mutation),
      ).toHaveLength(1);
      expect(cloud.createCount).toBe(initial === undefined ? 1 : 0);
    });
  }

  for (const mutation of [
    "server-unprotect",
    "server-delete",
  ] as const satisfies readonly MachineMutation[]) {
    it(`finishes deletion after interruption at ${mutation}`, async () => {
      const cloud = new FakeMachineCloud();
      const oldOutput = cloud.seed(
        server({ protection: { delete: mutation === "server-unprotect" } }),
      );
      let injected = false;

      await expect(
        deleteMachine(cloud, oldOutput, async (point) => {
          if (!injected && point === mutation) {
            injected = true;
            throw new Error(`injected failure after ${point}`);
          }
        }),
      ).rejects.toThrow(`injected failure after ${mutation}`);

      await deleteMachine(cloud, oldOutput);
      await deleteMachine(cloud, oldOutput);
      expect(cloud.servers.size).toBe(0);
      expect(
        cloud.mutations.filter((point) => point === mutation),
      ).toHaveLength(1);
    });
  }

  it("adopts a server when create succeeded but the response was lost", async () => {
    const cloud = new FakeMachineCloud();
    const originalCreate = cloud.createServer.bind(cloud);
    cloud.createServer = async (input) => {
      await originalCreate(input);
      throw new HcloudRequestError(409, "conflict", "response was lost");
    };

    const output = await reconcileMachine(cloud, identity, props);
    assertConverged(cloud, output);
    expect(cloud.createCount).toBe(1);
  });

  it("waits for an interrupted deletion before recreating the same identity", async () => {
    const cloud = new FakeMachineCloud();
    const oldOutput = cloud.seed(server({ status: "deleting" }));
    cloud.waitForGone = async (id) => {
      cloud.servers.delete(id);
    };

    const output = await reconcileMachine(cloud, identity, props, oldOutput);
    assertConverged(cloud, output);
    expect(output.id).not.toBe(oldOutput.id);
    expect(cloud.createCount).toBe(1);
  });

  it("never adopts a same-name server from another generation", async () => {
    const cloud = new FakeMachineCloud();
    cloud.seed(
      server({
        labels: { ...identity.labels, "k3s.generation": "foreign" },
      }),
    );

    await expect(reconcileMachine(cloud, identity, props)).rejects.toThrow(
      "ownership or generation labels do not match",
    );
    expect(cloud.mutations).toHaveLength(0);
  });

  it("retries an action response race by observing the desired state", async () => {
    const cloud = new FakeMachineCloud();
    const oldOutput = cloud.seed(server({ private_net: [] }));
    const attach = cloud.attachNetwork.bind(cloud);
    let attempts = 0;
    cloud.attachNetwork = async (id, networkId) => {
      attempts += 1;
      if (attempts === 1) {
        await attach(id, networkId);
        throw new HcloudRequestError(423, "locked", "action still running");
      }
      return attach(id, networkId);
    };

    const output = await reconcileMachine(cloud, identity, props, oldOutput);
    assertConverged(cloud, output);
    expect(attempts).toBe(1);
  });

  it("requests delete-first replacement when the physical server vanished", async () => {
    const cloud = new FakeMachineCloud();
    const oldOutput = attributes(server());

    await expect(
      diffMachine(cloud, identity, props, props, oldOutput),
    ).resolves.toEqual({ action: "replace", deleteFirst: true });
  });

  it("repairs mutable drift without replacing the machine", async () => {
    const cloud = new FakeMachineCloud();
    const oldOutput = cloud.seed(server({ private_net: [] }));

    await expect(
      diffMachine(cloud, identity, props, props, oldOutput),
    ).resolves.toEqual({ action: "update" });
  });
});
