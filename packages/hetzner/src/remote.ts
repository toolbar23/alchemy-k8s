import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Redacted from "effect/Redacted";
import { run } from "../../shared/src/process.ts";
import type { ServerReference } from "./types.ts";

const privateKeyOf = (server: ServerReference): string => {
  if (server.privateKey === undefined) {
    throw new Error(`Hetzner server ${server.name} has no Alchemy deploy key`);
  }
  return typeof server.privateKey === "string"
    ? server.privateKey
    : Redacted.value(server.privateKey);
};

export const ssh = async (
  server: ServerReference,
  command: string,
  timeout = 120_000,
): Promise<string> => {
  if (server.ipv4 === undefined)
    throw new Error(`Hetzner server ${server.name} has no public IPv4`);
  const directory = await mkdtemp(join(tmpdir(), "alchemy-k3s-ssh-"));
  const keyPath = join(directory, "id_ed25519");
  try {
    await writeFile(keyPath, privateKeyOf(server), { mode: 0o600 });
    const result = await run(
      "ssh",
      [
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        `root@${server.ipv4}`,
        command,
      ],
      { timeout },
    );
    return result.stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
