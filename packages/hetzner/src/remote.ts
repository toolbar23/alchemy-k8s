import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import { run } from "../../shared/src/process.ts";
import type { ServerReference } from "./types.ts";
import { cidrContains } from "./validation.ts";

const privateKeyOf = (server: ServerReference): string =>
  Redacted.value(server.privateKey);

export const knownHostsEntry = (address: string, publicKey: string): string => {
  const hostKey = publicKey.split(/\s+/).slice(0, 2).join(" ");
  return `${address} ${hostKey}\n`;
};

export const resolveServerAccess = async (
  server: ServerReference,
  networkCidr: string,
  hcloudToken: Redacted.Redacted<string>,
  privateManagement: boolean,
  fetcher: typeof fetch = fetch,
): Promise<ServerReference> => {
  if (!privateManagement) {
    if (server.ipv4 === undefined)
      throw new Error(`Hetzner server ${server.name} has no public IPv4`);
    return { ...server, managementAddress: server.ipv4 };
  }
  const response = await fetcher(
    `https://api.hetzner.cloud/v1/servers/${server.serverId}`,
    {
      headers: { Authorization: `Bearer ${Redacted.value(hcloudToken)}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve private management address for ${server.name}: HTTP ${response.status}`,
    );
  }
  const document = (await response.json()) as {
    server?: { private_net?: Array<{ ip?: string }> };
  };
  const address = document.server?.private_net
    ?.map(({ ip }) => ip)
    .find(
      (ip): ip is string => ip !== undefined && cidrContains(networkCidr, ip),
    );
  if (address === undefined) {
    throw new Error(
      `Hetzner server ${server.name} has no private network address in API output`,
    );
  }
  return { ...server, managementAddress: address };
};

export const ssh = async (
  server: ServerReference,
  command: string,
  timeout = 120_000,
): Promise<string> => {
  const address = server.managementAddress ?? server.ipv4;
  if (address === undefined)
    throw new Error(`Hetzner server ${server.name} has no management address`);
  const directory = await mkdtemp(join(tmpdir(), "alchemy-k3s-ssh-"));
  const keyPath = join(directory, "id_ed25519");
  const knownHostsPath = join(directory, "known_hosts");
  try {
    await writeFile(keyPath, privateKeyOf(server), { mode: 0o600 });
    await writeFile(
      knownHostsPath,
      knownHostsEntry(address, server.hostPublicKey),
      {
        mode: 0o600,
      },
    );
    const result = await run(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHostsPath}`,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        `root@${address}`,
        command,
      ],
      { timeout },
    );
    return result.stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const waitForCloudInit = async (
  server: ServerReference,
): Promise<void> => {
  await ssh(
    server,
    'cloud-init status --wait --long && test "$(cloud-init status --format=json | python3 -c \'import json,sys; print(json.load(sys.stdin)["status"] )\')" = done',
    10 * 60_000,
  );
};

export const sshScript = async (
  server: ServerReference,
  script: string,
  timeout = 300_000,
): Promise<string> => {
  const payload = Buffer.from(script).toString("base64");
  return await ssh(
    server,
    `printf %s ${JSON.stringify(payload)} | base64 -d | bash`,
    timeout,
  );
};

export const waitForSsh = async (server: ServerReference): Promise<void> => {
  const deadline = Date.now() + 5 * 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await ssh(server, "true", 20_000);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error(`Timed out waiting for SSH on ${server.name}`, {
    cause: lastError,
  });
};

export const remotePrivateIp = async (
  server: ServerReference,
  networkCidr: string,
): Promise<string> => {
  const program = [
    "import ipaddress,subprocess",
    `network=ipaddress.ip_network(${JSON.stringify(networkCidr)})`,
    "addresses=subprocess.check_output(['hostname','-I'],text=True).split()",
    "print(next(address for address in addresses if ipaddress.ip_address(address) in network))",
  ].join(";");
  const result = await ssh(server, `python3 -c ${JSON.stringify(program)}`);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(result)) {
    throw new Error(`No address in ${networkCidr} found on ${server.name}`);
  }
  return result;
};

export const k3sVersion = async (
  server: ServerReference,
): Promise<string | undefined> => {
  try {
    const result = await ssh(
      server,
      "k3s --version | awk 'NR == 1 { print $3 }'",
    );
    return result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
};
