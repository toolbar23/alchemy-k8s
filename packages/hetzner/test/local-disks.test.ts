import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { machineGeneration } from "../src/cluster.ts";
import {
  CONTAINERD_DIRECTORY,
  LOCAL_DISKS_SCRIPT,
  hardenedCloudInit,
  sshIdentity,
} from "../src/hardening.ts";

type CloudConfig = {
  growpart?: { mode: string };
  resize_rootfs?: boolean;
  write_files: Array<{ path: string; permissions: string; content: string }>;
  runcmd: string[][];
};

const cloudConfig = (userData: string): CloudConfig =>
  parse(
    userData
      .slice(userData.indexOf("#cloud-config"))
      .split("--alchemy-k3s--")[0]!,
  ) as CloudConfig;

const identity = sshIdentity("11".repeat(32), "local-disks-test");
const disks = { rootGiB: 10, containerdGiB: 10, volumeGroup: "cache" };

describe("Hetzner worker local disks", () => {
  it("leaves the image's disk handling alone without a layout", () => {
    const config = cloudConfig(hardenedCloudInit(identity));
    expect(config.growpart).toBeUndefined();
    expect(config.resize_rootfs).toBeUndefined();
    expect(config.write_files.map((file) => file.path)).toEqual([
      "/etc/ssh/sshd_config.d/99-alchemy-k3s.conf",
    ]);
    expect(config.runcmd).toEqual([
      ["/usr/sbin/sshd", "-t"],
      ["systemctl", "restart", "ssh"],
    ]);
  });

  it("stops growpart and runs the layout script after sshd", () => {
    const config = cloudConfig(hardenedCloudInit(identity, undefined, disks));
    expect(config.growpart).toEqual({ mode: "off" });
    expect(config.resize_rootfs).toBe(false);
    const script = config.write_files.find(
      (file) => file.path === "/usr/local/sbin/alchemy-k3s-local-disks",
    );
    expect(script?.permissions).toBe("0755");
    expect(script?.content).toBe(LOCAL_DISKS_SCRIPT);
    expect(config.runcmd.at(-1)).toEqual([
      "/usr/local/sbin/alchemy-k3s-local-disks",
      "10G",
      "10G",
      "cache",
    ]);
  });

  it("renders a script that bash accepts and that guards K3s on the mount", () => {
    const syntax = spawnSync("bash", ["-n"], {
      input: LOCAL_DISKS_SCRIPT,
      encoding: "utf8",
    });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
    expect(LOCAL_DISKS_SCRIPT).toContain(
      `CONTAINERD_DIR=${CONTAINERD_DIRECTORY}`,
    );
    expect(LOCAL_DISKS_SCRIPT).toContain(
      "ExecStartPre=/usr/bin/mountpoint -q %s",
    );
    expect(LOCAL_DISKS_SCRIPT).toContain("ROOT_SIZE=${1:?root size}");
  });

  it("replaces machines only when a pool's layout changes", () => {
    const plain = machineGeneration("cx33", "fsn1", undefined);
    expect(machineGeneration("cx33", "fsn1", undefined, undefined)).toBe(plain);
    const carved = machineGeneration("cx33", "fsn1", undefined, disks);
    expect(carved).not.toBe(plain);
    expect(
      machineGeneration("cx33", "fsn1", undefined, { ...disks, rootGiB: 12 }),
    ).not.toBe(carved);
  });
});
