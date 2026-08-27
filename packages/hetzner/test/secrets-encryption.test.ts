import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Redacted from "effect/Redacted";
import type { NodeReference, ServerReference } from "../src/types.ts";

const remote = vi.hoisted(() => ({
  ssh: vi.fn(),
  sshScript: vi.fn(),
  k3sVersion: vi.fn(),
}));

vi.mock("../src/remote.ts", () => remote);

const {
  ensureSecretsEncryption,
  prepareExistingClusterEncryption,
  rotateSecretsEncryptionKeys,
} = await import("../src/secrets-encryption.ts");

const server: ServerReference = {
  id: 1,
  serverId: 1,
  name: "control-plane",
  ipv4: "192.0.2.1",
  privateKey: Redacted.make("private"),
  hostPublicKey: "ssh-ed25519 host",
};

const node: NodeReference = {
  logicalName: "control-plane",
  name: "control-plane-1",
  role: "server",
  serverId: 1,
  privateIp: "10.0.0.2",
  version: "v1.35.3+k3s1",
  server,
};

const status = (
  enabled: boolean,
  stage: string,
  provider: "AES-CBC" | "Secretbox",
  hashes = "All hashes match",
) => `Encryption Status: ${enabled ? "Enabled" : "Disabled"}
Current Rotation Stage: ${stage}
Server Encryption Hashes: ${hashes}
Active  Key Type  Name
------  --------  ----
 *      ${provider} key
`;

beforeEach(() => {
  remote.ssh.mockReset();
  remote.sshScript.mockReset();
  remote.k3sVersion.mockReset();
});

describe("existing K3s Secret encryption", () => {
  it("requires explicit consent and a supported installed version", async () => {
    remote.ssh.mockResolvedValueOnce(
      "Encryption Status: Disabled, no configuration file found",
    );
    await expect(
      prepareExistingClusterEncryption(
        server,
        "v1.35.3+k3s1",
        "v1.35.3+k3s1",
        false,
        undefined,
      ),
    ).rejects.toThrow("migrateExisting");

    remote.ssh.mockResolvedValueOnce(
      "Encryption Status: Disabled, no configuration file found",
    );
    await expect(
      prepareExistingClusterEncryption(
        server,
        "v1.35.2+k3s1",
        "v1.35.3+k3s1",
        true,
        undefined,
      ),
    ).rejects.toThrow("upgrade first");
    expect(remote.sshScript).not.toHaveBeenCalled();
  });

  it("prepares an aescbc-to-secretbox migration with a verified snapshot", async () => {
    remote.ssh.mockResolvedValueOnce(
      status(true, "reencrypt_finished", "AES-CBC"),
    );
    remote.sshScript.mockResolvedValueOnce("");

    await prepareExistingClusterEncryption(
      server,
      "v1.35.2+k3s1",
      "v1.35.3+k3s1",
      true,
      undefined,
    );

    const script = remote.sshScript.mock.calls[0]?.[1] as string;
    expect(script).toContain("k3s etcd-snapshot save");
    expect(script).toContain('"provider"');
    expect(script).toContain("-size +0c");
  });

  it("runs the guarded enablement state machine to completion", async () => {
    let encryptionStatus = status(false, "start", "AES-CBC");
    remote.ssh.mockImplementation(
      async (_server: ServerReference, command: string) => {
        if (command.includes(".alchemy-secrets-encryption-migration")) {
          return "snapshot=pre-migration\nphase=prepared\nmode=enable";
        }
        if (command === "k3s secrets-encrypt status") {
          return encryptionStatus;
        }
        if (command === "k3s secrets-encrypt rotate-keys") {
          encryptionStatus = status(true, "reencrypt_finished", "Secretbox");
          return "";
        }
        if (command.includes("kubectl wait")) return "";
        throw new Error(`Unexpected SSH command: ${command}`);
      },
    );
    remote.sshScript.mockResolvedValue("");

    await ensureSecretsEncryption([node], undefined);

    expect(remote.ssh).toHaveBeenCalledWith(
      server,
      "k3s secrets-encrypt rotate-keys",
      30 * 60_000,
    );
    expect(
      remote.sshScript.mock.calls.some(([, script]) =>
        String(script).includes("systemctl restart k3s"),
      ),
    ).toBe(true);
    expect(
      remote.sshScript.mock.calls.some(([, script]) =>
        String(script).includes('"complete"'),
      ),
    ).toBe(true);
  });

  it("refuses to advance when control-plane encryption hashes disagree", async () => {
    remote.ssh
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(
        status(true, "reencrypt_finished", "Secretbox", "hash does not match"),
      );

    await expect(ensureSecretsEncryption([node], undefined)).rejects.toThrow(
      "hashes do not match",
    );
    expect(remote.sshScript).not.toHaveBeenCalled();
  });

  it("uses K3s dynamic key rotation and verifies the result", async () => {
    remote.k3sVersion.mockResolvedValue("v1.35.7+k3s1");
    remote.ssh
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(status(true, "reencrypt_finished", "Secretbox"));

    await rotateSecretsEncryptionKeys([node]);

    expect(remote.ssh).toHaveBeenNthCalledWith(
      1,
      server,
      "k3s secrets-encrypt rotate-keys",
      5 * 60_000,
    );
  });
});
