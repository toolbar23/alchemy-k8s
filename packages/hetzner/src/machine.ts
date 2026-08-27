import { Resource, isResolved } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Hetzner from "alchemy/Hetzner";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type {
  MachineAttributes,
  MachineProps,
  MachineResource,
} from "./types.ts";

export const Machine = Resource<MachineResource>("Hetzner.K3s.Machine");

export type MachineMutation =
  | "server-create"
  | "server-power-on"
  | "metadata-update"
  | "protection-change"
  | "network-detach"
  | "network-attach"
  | "firewall-remove"
  | "firewall-apply"
  | "server-unprotect"
  | "server-delete";

export interface CloudServer {
  id: number;
  name: string;
  status: string;
  server_type: { id: number; name: string };
  image: { id: number; name: string | null } | null;
  location: { id: number; name: string };
  public_net: {
    ipv4: { ip: string } | null;
    ipv6: { ip: string } | null;
    firewalls: Array<{ id: number }>;
  };
  private_net: Array<{ network: number }>;
  protection: { delete: boolean };
  created: string;
  labels: Record<string, string>;
}

interface MutationResult {
  actionIds: number[];
}

export interface MachineCloud {
  getServer(id: number): Promise<CloudServer | undefined>;
  findServer(name: string): Promise<CloudServer | undefined>;
  createServer(input: {
    name: string;
    props: MachineProps;
    labels: Record<string, string>;
  }): Promise<{ server: CloudServer; actionIds: number[] }>;
  updateMetadata(
    id: number,
    name: string,
    labels: Record<string, string>,
  ): Promise<void>;
  powerOn(id: number): Promise<MutationResult>;
  changeProtection(id: number, enabled: boolean): Promise<MutationResult>;
  attachNetwork(id: number, networkId: number): Promise<MutationResult>;
  detachNetwork(id: number, networkId: number): Promise<MutationResult>;
  applyFirewall(id: number, firewallId: number): Promise<MutationResult>;
  removeFirewall(id: number, firewallId: number): Promise<MutationResult>;
  deleteServer(id: number): Promise<MutationResult>;
  waitForActions(actionIds: number[]): Promise<void>;
  waitForReady(id: number): Promise<CloudServer>;
  waitForGone(id: number): Promise<void>;
}

interface MachineIdentity {
  name: string;
  labels: Record<string, string>;
}

interface HcloudErrorDocument {
  error?: { code?: string; message?: string };
}

export class HcloudRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Hetzner API ${status} ${code}: ${message}`);
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sameSet = (
  left: readonly number[],
  right: readonly number[],
): boolean => {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
};

const sameLabels = (
  observed: Record<string, string>,
  desired: Record<string, string>,
): boolean => {
  const observedEntries = Object.entries(observed);
  const desiredEntries = Object.entries(desired);
  return (
    observedEntries.length === desiredEntries.length &&
    desiredEntries.every(([key, value]) => observed[key] === value)
  );
};

const toAttributes = (server: CloudServer): MachineAttributes => ({
  id: server.id,
  serverId: server.id,
  name: server.name,
  status: server.status,
  serverType: server.server_type.name,
  serverTypeId: server.server_type.id,
  image: server.image?.name ?? undefined,
  imageId: server.image?.id,
  location: server.location.name,
  locationId: server.location.id,
  ipv4: server.public_net.ipv4?.ip,
  ipv6: server.public_net.ipv6?.ip,
  networkIds: server.private_net.map(({ network }) => network),
  firewallIds: server.public_net.firewalls.map(({ id }) => id),
  deleteProtection: server.protection.delete,
  created: server.created,
  labels: { ...server.labels },
});

const observeMachine = async (
  cloud: MachineCloud,
  identity: MachineIdentity,
  output: MachineAttributes | undefined,
): Promise<CloudServer | undefined> => {
  if (output !== undefined) {
    const byId = await cloud.getServer(output.id);
    if (byId !== undefined) return byId;
  }
  return cloud.findServer(identity.name);
};

const refreshMachine = async (
  cloud: MachineCloud,
  id: number,
): Promise<CloudServer> => {
  const server = await cloud.getServer(id);
  if (server === undefined) {
    throw new Error(`Hetzner server ${id} disappeared during reconciliation`);
  }
  return server;
};

const waitForNamedMachine = async (
  cloud: MachineCloud,
  name: string,
): Promise<CloudServer> => {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const server = await cloud.findServer(name);
    if (server !== undefined) return server;
    await delay(2_000);
  }
  throw new Error(
    `Hetzner reported a name conflict for ${name}, but the server never became observable`,
  );
};

const mutate = async (
  mutation: MachineMutation,
  start: () => Promise<MutationResult>,
  satisfied: () => Promise<boolean>,
  cloud: MachineCloud,
  afterMutation: (mutation: MachineMutation) => Promise<void>,
): Promise<void> => {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      const result = await start();
      await afterMutation(mutation);
      await cloud.waitForActions(result.actionIds);
      return;
    } catch (error) {
      if (
        !(error instanceof HcloudRequestError) ||
        (error.code !== "locked" &&
          error.status !== 423 &&
          error.status !== 422)
      ) {
        throw error;
      }
      if (await satisfied()) return;
      await delay(2_000);
    }
  }
  throw new Error(`Timed out retrying locked Hetzner mutation ${mutation}`);
};

export const reconcileMachine = async (
  cloud: MachineCloud,
  identity: MachineIdentity,
  props: MachineProps,
  output?: MachineAttributes,
  afterMutation: (mutation: MachineMutation) => Promise<void> = async () => {},
): Promise<MachineAttributes> => {
  let current = await observeMachine(cloud, identity, output);
  if (current?.status === "deleting") {
    await cloud.waitForGone(current.id);
    current = undefined;
  }
  if (current === undefined) {
    try {
      const created = await cloud.createServer({
        name: identity.name,
        props,
        labels: identity.labels,
      });
      current = created.server;
      await afterMutation("server-create");
      await cloud.waitForActions(created.actionIds);
    } catch (error) {
      if (!(error instanceof HcloudRequestError) || error.status !== 409) {
        throw error;
      }
      current = await waitForNamedMachine(cloud, identity.name);
    }
  }
  if (!isOwnedMachine(current, identity)) {
    throw new Error(
      `Refusing to reconcile Hetzner server ${current.name}: its ownership or generation labels do not match`,
    );
  }
  current = await cloud.waitForReady(current.id);

  if (current.status === "off") {
    await mutate(
      "server-power-on",
      () => cloud.powerOn(current!.id),
      async () => (await cloud.getServer(current!.id))?.status === "running",
      cloud,
      afterMutation,
    );
    current = await cloud.waitForReady(current.id);
  }

  if (
    current.name !== identity.name ||
    current.status !== "running" ||
    !sameLabels(current.labels, identity.labels)
  ) {
    await mutate(
      "metadata-update",
      async () => {
        await cloud.updateMetadata(current!.id, identity.name, identity.labels);
        return { actionIds: [] };
      },
      async () => {
        const observed = await cloud.getServer(current!.id);
        return (
          observed !== undefined &&
          observed.name === identity.name &&
          sameLabels(observed.labels, identity.labels)
        );
      },
      cloud,
      afterMutation,
    );
    current = await refreshMachine(cloud, current.id);
  }

  const desiredNetworkIds = [props.network.networkId];
  const observedNetworkIds = current.private_net.map(({ network }) => network);
  if (!sameSet(observedNetworkIds, desiredNetworkIds)) {
    for (const networkId of observedNetworkIds) {
      if (desiredNetworkIds.includes(networkId)) continue;
      await mutate(
        "network-detach",
        () => cloud.detachNetwork(current!.id, networkId),
        async () =>
          !(await cloud.getServer(current!.id))?.private_net.some(
            ({ network }) => network === networkId,
          ),
        cloud,
        afterMutation,
      );
      current = await refreshMachine(cloud, current.id);
    }
    if (
      !current.private_net.some(
        ({ network }) => network === props.network.networkId,
      )
    ) {
      await mutate(
        "network-attach",
        () => cloud.attachNetwork(current!.id, props.network.networkId),
        async () =>
          (await cloud.getServer(current!.id))?.private_net.some(
            ({ network }) => network === props.network.networkId,
          ) === true,
        cloud,
        afterMutation,
      );
      current = await refreshMachine(cloud, current.id);
    }
  }

  const desiredFirewallIds = [props.firewall.id];
  const observedFirewallIds = current.public_net.firewalls.map(({ id }) => id);
  if (!sameSet(observedFirewallIds, desiredFirewallIds)) {
    for (const firewallId of observedFirewallIds) {
      if (desiredFirewallIds.includes(firewallId)) continue;
      await mutate(
        "firewall-remove",
        () => cloud.removeFirewall(current!.id, firewallId),
        async () =>
          !(await cloud.getServer(current!.id))?.public_net.firewalls.some(
            ({ id }) => id === firewallId,
          ),
        cloud,
        afterMutation,
      );
      current = await refreshMachine(cloud, current.id);
    }
    if (
      !current.public_net.firewalls.some(({ id }) => id === props.firewall.id)
    ) {
      await mutate(
        "firewall-apply",
        () => cloud.applyFirewall(current!.id, props.firewall.id),
        async () =>
          (await cloud.getServer(current!.id))?.public_net.firewalls.some(
            ({ id }) => id === props.firewall.id,
          ) === true,
        cloud,
        afterMutation,
      );
      current = await refreshMachine(cloud, current.id);
    }
  }

  if (current.protection.delete !== props.deleteProtection) {
    await mutate(
      "protection-change",
      () => cloud.changeProtection(current!.id, props.deleteProtection),
      async () =>
        (await cloud.getServer(current!.id))?.protection.delete ===
        props.deleteProtection,
      cloud,
      afterMutation,
    );
    current = await refreshMachine(cloud, current.id);
  }

  const finalNetworkIds = current.private_net.map(({ network }) => network);
  const finalFirewallIds = current.public_net.firewalls.map(({ id }) => id);
  if (
    current.name !== identity.name ||
    !sameLabels(current.labels, identity.labels) ||
    !sameSet(finalNetworkIds, desiredNetworkIds) ||
    !sameSet(finalFirewallIds, desiredFirewallIds) ||
    current.protection.delete !== props.deleteProtection
  ) {
    throw new Error(
      `Hetzner server ${current.name} did not converge to its declared identity, network, firewall, and protection state`,
    );
  }
  return toAttributes(current);
};

export const deleteMachine = async (
  cloud: MachineCloud,
  output: MachineAttributes,
  afterMutation: (mutation: MachineMutation) => Promise<void> = async () => {},
): Promise<void> => {
  const current = await cloud.getServer(output.id);
  if (current !== undefined) {
    if (current.status === "deleting") {
      await cloud.waitForGone(current.id);
      return;
    }
    if (current.protection.delete) {
      await mutate(
        "server-unprotect",
        () => cloud.changeProtection(current.id, false),
        async () =>
          (await cloud.getServer(current.id))?.protection.delete !== true,
        cloud,
        afterMutation,
      );
    }
    await mutate(
      "server-delete",
      () => cloud.deleteServer(current.id),
      async () => {
        const observed = await cloud.getServer(current.id);
        return observed === undefined || observed.status === "deleting";
      },
      cloud,
      afterMutation,
    );
    await cloud.waitForGone(current.id);
  }
};

const requestJson = async <T>(
  token: Redacted.Redacted<string>,
  endpoint: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${Redacted.value(token)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const document = (await response
      .json()
      .catch(() => ({}))) as HcloudErrorDocument;
    throw new HcloudRequestError(
      response.status,
      document.error?.code ?? "unknown",
      document.error?.message ?? response.statusText,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

export const createMachineCloud = (
  token: Redacted.Redacted<string>,
  endpoint: string,
): MachineCloud => {
  const getServer = async (id: number): Promise<CloudServer | undefined> => {
    try {
      return (
        await requestJson<{ server: CloudServer }>(
          token,
          endpoint,
          "GET",
          `/servers/${id}`,
        )
      ).server;
    } catch (error) {
      if (error instanceof HcloudRequestError && error.status === 404)
        return undefined;
      throw error;
    }
  };
  const actionIds = (document: {
    action?: { id: number } | null;
    actions?: Array<{ id: number }>;
    next_actions?: Array<{ id: number }>;
  }): number[] => [
    ...(document.action === undefined || document.action === null
      ? []
      : [document.action.id]),
    ...(document.actions ?? []).map(({ id }) => id),
    ...(document.next_actions ?? []).map(({ id }) => id),
  ];
  return {
    getServer,
    findServer: async (name) =>
      (
        await requestJson<{ servers: CloudServer[] }>(
          token,
          endpoint,
          "GET",
          `/servers?name=${encodeURIComponent(name)}`,
        )
      ).servers.find((server) => server.name === name),
    createServer: async ({ name, props, labels }) => {
      const document = await requestJson<{
        server: CloudServer;
        action?: { id: number };
        next_actions?: Array<{ id: number }>;
      }>(token, endpoint, "POST", "/servers", {
        name,
        server_type: props.serverType,
        image: props.image,
        location: props.location,
        labels,
        start_after_create: true,
        ssh_keys: [props.sshKey.id],
        networks: [props.network.networkId],
        firewalls: [{ firewall: props.firewall.id }],
        user_data: props.userData,
        public_net: {
          enable_ipv4: props.enableIpv4,
          enable_ipv6: props.enableIpv6,
        },
      });
      return { server: document.server, actionIds: actionIds(document) };
    },
    updateMetadata: async (id, name, labels) => {
      await requestJson(token, endpoint, "PUT", `/servers/${id}`, {
        name,
        labels,
      });
    },
    powerOn: async (id) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/servers/${id}/actions/poweron`,
      ).then((document) => ({
        actionIds: actionIds(document as { action?: { id: number } }),
      })),
    changeProtection: async (id, enabled) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/servers/${id}/actions/change_protection`,
        {
          delete: enabled,
          rebuild: enabled,
        },
      ).then((document) => ({
        actionIds: actionIds(document as { action?: { id: number } }),
      })),
    attachNetwork: async (id, networkId) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/servers/${id}/actions/attach_to_network`,
        {
          network: networkId,
        },
      ).then((document) => ({
        actionIds: actionIds(document as { action?: { id: number } }),
      })),
    detachNetwork: async (id, networkId) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/servers/${id}/actions/detach_from_network`,
        {
          network: networkId,
        },
      ).then((document) => ({
        actionIds: actionIds(document as { action?: { id: number } }),
      })),
    applyFirewall: async (id, firewallId) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/firewalls/${firewallId}/actions/apply_to_resources`,
        {
          apply_to: [{ type: "server", server: { id } }],
        },
      ).then((document) => ({
        actionIds: actionIds(document as { actions?: Array<{ id: number }> }),
      })),
    removeFirewall: async (id, firewallId) =>
      requestJson(
        token,
        endpoint,
        "POST",
        `/firewalls/${firewallId}/actions/remove_from_resources`,
        {
          remove_from: [{ type: "server", server: { id } }],
        },
      ).then((document) => ({
        actionIds: actionIds(document as { actions?: Array<{ id: number }> }),
      })),
    deleteServer: async (id) => {
      try {
        const document = await requestJson(
          token,
          endpoint,
          "DELETE",
          `/servers/${id}`,
        );
        return {
          actionIds: actionIds(document as { action?: { id: number } }),
        };
      } catch (error) {
        if (error instanceof HcloudRequestError && error.status === 404) {
          return { actionIds: [] };
        }
        throw error;
      }
    },
    waitForActions: async (ids) => {
      for (const id of ids) {
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          const action = (
            await requestJson<{
              action: {
                status: string;
                command: string;
                error?: { code?: string; message?: string } | null;
              };
            }>(token, endpoint, "GET", `/actions/${id}`)
          ).action;
          if (action.status === "success") break;
          if (action.status === "error") {
            throw new Error(
              `Hetzner action ${id} (${action.command}) failed: ${action.error?.code ?? "unknown"}: ${action.error?.message ?? "unknown error"}`,
            );
          }
          await delay(2_000);
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Hetzner action ${id}`);
        }
      }
    },
    waitForReady: async (id) => {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const server = await getServer(id);
        if (
          server !== undefined &&
          ["running", "off"].includes(server.status)
        ) {
          return server;
        }
        await delay(2_000);
      }
      throw new Error(`Timed out waiting for Hetzner server ${id} readiness`);
    },
    waitForGone: async (id) => {
      const deadline = Date.now() + 2 * 60_000;
      while (Date.now() < deadline) {
        if ((await getServer(id)) === undefined) return;
        await delay(2_000);
      }
      throw new Error(`Timed out waiting for Hetzner server ${id} deletion`);
    },
  };
};

const machineIdentity = (id: string, props: MachineProps) =>
  Effect.gen(function* () {
    const labels = {
      ...Hetzner.toLabels(props.labels),
      ...(yield* Hetzner.createInternalLabels(id)),
      "k3s.generation": props.generation,
    };
    return { name: props.name, labels } satisfies MachineIdentity;
  });

const isOwnedMachine = (
  server: CloudServer,
  identity: MachineIdentity,
): boolean => {
  const expectedAlchemyLabels = Object.entries(identity.labels).filter(
    ([key]) => key.startsWith("alchemy."),
  );
  return (
    server.labels["k3s.generation"] === identity.labels["k3s.generation"] &&
    expectedAlchemyLabels.every(([key, value]) => server.labels[key] === value)
  );
};

export const diffMachine = async (
  cloud: MachineCloud,
  identity: MachineIdentity,
  news: MachineProps,
  olds: MachineProps,
  output: MachineAttributes,
): Promise<
  { action: "replace"; deleteFirst: true } | { action: "update" } | undefined
> => {
  const observed = await observeMachine(cloud, identity, output);
  if (observed === undefined) {
    return { action: "replace", deleteFirst: true };
  }
  if (observed.status === "deleting") {
    return { action: "replace", deleteFirst: true };
  }
  if (
    news.generation !== olds.generation ||
    news.name !== olds.name ||
    news.serverType !== olds.serverType ||
    news.image !== olds.image ||
    news.location !== olds.location ||
    news.sshKey.id !== olds.sshKey.id ||
    news.userData !== olds.userData ||
    news.enableIpv4 !== olds.enableIpv4 ||
    news.enableIpv6 !== olds.enableIpv6 ||
    observed.server_type.name !== news.serverType ||
    observed.image?.name !== news.image ||
    observed.location.name !== news.location ||
    (observed.public_net.ipv4 !== null) !== news.enableIpv4 ||
    (observed.public_net.ipv6 !== null) !== news.enableIpv6
  ) {
    return { action: "replace", deleteFirst: true };
  }
  if (
    observed.status !== "running" ||
    observed.name !== identity.name ||
    !sameLabels(observed.labels, identity.labels) ||
    !sameSet(
      observed.private_net.map(({ network }) => network),
      [news.network.networkId],
    ) ||
    !sameSet(
      observed.public_net.firewalls.map(({ id }) => id),
      [news.firewall.id],
    ) ||
    observed.protection.delete !== news.deleteProtection
  ) {
    return { action: "update" };
  }
  return undefined;
};

export const MachineProvider = () =>
  Provider.succeed(Machine, {
    stables: [
      "id",
      "serverId",
      "created",
      "location",
      "locationId",
      "ipv4",
      "ipv6",
    ],
    read: ({ id, olds, output }) =>
      Effect.gen(function* () {
        const cloud = createMachineCloud(
          olds.credentials.token,
          olds.credentials.apiBaseUrl,
        );
        const identity = yield* machineIdentity(id, olds);
        const observed = yield* Effect.tryPromise(() =>
          observeMachine(cloud, identity, output),
        );
        if (observed === undefined) return undefined;
        const attrs = toAttributes(observed);
        return isOwnedMachine(observed, identity) ? attrs : Unowned(attrs);
      }),
    diff: ({ id, news, olds, output }) =>
      Effect.gen(function* () {
        if (!isResolved(news) || output === undefined) return undefined;
        const cloud = createMachineCloud(
          news.credentials.token,
          news.credentials.apiBaseUrl,
        );
        const identity = yield* machineIdentity(id, news);
        return yield* Effect.tryPromise(() =>
          diffMachine(cloud, identity, news, olds, output),
        );
      }),
    reconcile: ({ id, news, output }) =>
      Effect.gen(function* () {
        const cloud = createMachineCloud(
          news.credentials.token,
          news.credentials.apiBaseUrl,
        );
        const identity = yield* machineIdentity(id, news);
        const observed = yield* Effect.tryPromise(() =>
          observeMachine(cloud, identity, output),
        );
        if (observed !== undefined && !isOwnedMachine(observed, identity)) {
          throw new Error(
            `Refusing to mutate Hetzner server ${observed.name}: ownership labels do not match ${id}`,
          );
        }
        return yield* Effect.tryPromise({
          try: () => reconcileMachine(cloud, identity, news, output),
          catch: (cause) =>
            new Error(`Failed to reconcile Hetzner K3s machine ${id}`, {
              cause,
            }),
        });
      }),
    delete: ({ id, olds, output }) =>
      Effect.gen(function* () {
        const cloud = createMachineCloud(
          olds.credentials.token,
          olds.credentials.apiBaseUrl,
        );
        const identity = yield* machineIdentity(id, olds);
        const observed = yield* Effect.tryPromise(() =>
          cloud.getServer(output.id),
        );
        if (observed !== undefined && !isOwnedMachine(observed, identity)) {
          throw new Error(
            `Refusing to delete Hetzner server ${observed.name}: ownership labels do not match ${id}`,
          );
        }
        return yield* Effect.tryPromise({
          try: () => deleteMachine(cloud, output),
          catch: (cause) =>
            new Error(`Failed to delete Hetzner K3s machine ${output.name}`, {
              cause,
            }),
        });
      }),
  });
