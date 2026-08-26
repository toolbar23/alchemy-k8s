import * as Redacted from "effect/Redacted";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../shared/src/process.ts", () => processMock);

const { knownHostsEntry, resolveServerAccess, ssh } =
  await import("../src/remote.ts");

const server = {
  id: 1,
  serverId: 2,
  name: "cp-1",
  ipv4: "203.0.113.2",
  privateKey: Redacted.make("private"),
  hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest cp-1",
};

beforeEach(() => processMock.run.mockReset());

describe("verified Hetzner SSH", () => {
  it("uses the pinned host key and never disables checking", async () => {
    processMock.run.mockResolvedValue({ stdout: "ok\n", stderr: "", code: 0 });
    expect(
      await ssh({ ...server, managementAddress: server.ipv4 }, "true"),
    ).toBe("ok");
    const arguments_ = processMock.run.mock.calls[0]![1] as string[];
    expect(arguments_).toContain("StrictHostKeyChecking=yes");
    expect(arguments_).not.toContain("StrictHostKeyChecking=no");
    expect(
      arguments_.some((argument) => argument.startsWith("UserKnownHostsFile=")),
    ).toBe(true);
    expect(knownHostsEntry(server.ipv4, server.hostPublicKey)).toBe(
      "203.0.113.2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n",
    );
  });

  it("resolves a private-only management address through the Hetzner API", async () => {
    const resolved = await resolveServerAccess(
      server,
      "10.0.0.0/16",
      Redacted.make("hcloud"),
      true,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ server: { private_net: [{ ip: "10.0.0.4" }] } }),
        ),
    );
    expect(resolved.managementAddress).toBe("10.0.0.4");
  });
});
