import * as Redacted from "effect/Redacted";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { hardenedCloudInit, hostIdentity } from "../src/hardening.ts";
import {
  assertSafeRestoreVersion,
  buildRecoveryScript,
  k3sS3Arguments,
  k3sTokenHash,
  listRemoteEtcdSnapshots,
  selectRecoverySnapshot,
  type RemoteEtcdSnapshot,
} from "../src/recovery.ts";

const access = {
  endpoint: "https://objects.example.test",
  region: "eu-central-1",
  bucket: "backups",
  accessKeyId: "access",
  secretAccessKey: Redacted.make("secret"),
  sessionToken: Redacted.make("session"),
  forcePathStyle: true,
};

describe("Hetzner K3s disaster recovery", () => {
  it("lists S3 snapshots without a Kubernetes API and preserves temporary credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>clusters/a/etcd-snapshot-cp-1700000000</Key><LastModified>2026-08-26T10:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>4096</Size></Contents><Contents><Key>clusters/a/.metadata/etcd-snapshot-cp-1700000000</Key><LastModified>2026-08-26T10:00:00.000Z</LastModified><ETag>&quot;meta&quot;</ETag><Size>20</Size></Contents></ListBucketResult>`,
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "x-amz-meta-k3s-cluster-id": "cluster-a",
            "x-amz-meta-k3s-token-hash": k3sTokenHash("original-token"),
            "x-amz-meta-k3s-node-name": "cp-1",
          },
        }),
      );

    const snapshots = await listRemoteEtcdSnapshots(
      access,
      "clusters/a",
      fetcher,
    );

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      name: "etcd-snapshot-cp-1700000000",
      size: 4096,
      clusterId: "cluster-a",
    });
    const [listUrl, listInit] = fetcher.mock.calls[0]!;
    expect(String(listUrl)).toContain("/backups/?list-type=2");
    expect(new Headers(listInit?.headers).get("authorization")).toContain(
      "Credential=access/",
    );
    expect(new Headers(listInit?.headers).get("x-amz-security-token")).toBe(
      "session",
    );
  });

  it("selects only a fresh snapshot from the original cluster and token", () => {
    const now = new Date("2026-08-26T10:05:00.000Z");
    const snapshot = (
      overrides: Partial<RemoteEtcdSnapshot>,
    ): RemoteEtcdSnapshot => ({
      key: "clusters/a/snapshot",
      name: "snapshot",
      size: 100,
      createdAt: new Date("2026-08-26T10:04:00.000Z"),
      etag: "etag",
      clusterId: "cluster-a",
      tokenHash: k3sTokenHash("K10ca::server:password"),
      ...overrides,
    });
    const selected = selectRecoverySnapshot(
      [
        snapshot({ name: "empty", size: 0 }),
        snapshot({ name: "foreign", clusterId: "cluster-b" }),
        snapshot({
          name: "old",
          createdAt: new Date("2026-08-26T08:00:00.000Z"),
        }),
        snapshot({ name: "new" }),
      ],
      "cluster-a",
      "K10ca::server:password",
      600,
      now,
    );
    expect(selected.name).toBe("new");
    expect(() =>
      selectRecoverySnapshot(
        [snapshot({ clusterId: "other" })],
        "cluster-a",
        "K10ca::server:password",
        600,
        now,
      ),
    ).toThrow("No unambiguous non-empty K3s snapshot matched");

    expect(
      selectRecoverySnapshot(
        [snapshot({ name: "legacy" })],
        undefined,
        "K10ca::server:password",
        600,
        now,
      ).name,
    ).toBe("legacy");
    expect(() =>
      selectRecoverySnapshot(
        [snapshot({}), snapshot({ clusterId: "cluster-b" })],
        undefined,
        "K10ca::server:password",
        600,
        now,
      ),
    ).toThrow("one legacy cluster identity");
  });

  it("passes every S3 option to install and the resumable restore", () => {
    expect(k3sS3Arguments(access, "clusters/a", 24)).toEqual(
      expect.arrayContaining([
        "--etcd-s3-session-token",
        "session",
        "--etcd-s3-folder",
        "clusters/a",
        "--etcd-s3-bucket-lookup-type",
        "path",
      ]),
    );
    const script = buildRecoveryScript(
      {
        key: "clusters/a/snapshot",
        name: "snapshot",
        size: 100,
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
        etag: "etag",
      },
      "token",
      access,
      "clusters/a",
      24,
      {
        restoreOnInitialControlPlaneReplacement: true,
        maximumSnapshotAge: 600,
        failureInjection: "after-etcd-reset",
      },
    );
    expect(script).toContain("--cluster-reset-restore-path='snapshot'");
    expect(script).toContain("'--etcd-s3-session-token' 'session'");
    expect(script).toContain('phase=$(cat "$checkpoint"');
    expect(script).toContain("Injected recovery failure at after-etcd-reset");
    expect(script).toContain("get --raw=/readyz");
  });

  it("refuses K3s versions affected by compressed restore traversal", () => {
    expect(() => assertSafeRestoreVersion("v1.35.2+k3s1")).toThrow("not safe");
    expect(() => assertSafeRestoreVersion("v1.35.3+k3s1")).not.toThrow();
    expect(() => assertSafeRestoreVersion("v1.36.0+k3s1")).not.toThrow();
  });

  it("generates deterministic pinned host identity and hardened cloud-init", () => {
    const identity = hostIdentity("11".repeat(32), "server-1");
    expect(hostIdentity("11".repeat(32), "server-1")).toEqual(identity);
    expect(identity.publicKey).toMatch(/^ssh-ed25519 /);
    expect(identity.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    const directory = mkdtempSync(join(tmpdir(), "alchemy-host-key-test-"));
    try {
      const privateKey = join(directory, "host-key");
      writeFileSync(privateKey, identity.privateKey, { mode: 0o600 });
      const derived = spawnSync("ssh-keygen", ["-y", "-f", privateKey], {
        encoding: "utf8",
      });
      expect(derived.status).toBe(0);
      expect(derived.stdout.trim().split(/\s+/).slice(0, 2).join(" ")).toBe(
        identity.publicKey.split(/\s+/).slice(0, 2).join(" "),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    const userData = hardenedCloudInit(identity, "generation-2");
    const cloudConfig = parse(
      userData
        .slice(userData.indexOf("#cloud-config"))
        .split("--alchemy-k3s--")[0]!,
    ) as {
      ssh_deletekeys: boolean;
      ssh_genkeytypes?: string[];
      ssh_keys: { ed25519_private: string; ed25519_public: string };
      write_files: Array<{ path: string }>;
    };
    expect(cloudConfig.ssh_deletekeys).toBe(true);
    expect(cloudConfig.ssh_genkeytypes).toBeUndefined();
    expect(cloudConfig.ssh_keys).toEqual({
      ed25519_private: identity.privateKey,
      ed25519_public: identity.publicKey,
    });
    expect(cloudConfig.write_files.map(({ path }) => path)).toEqual([
      "/etc/ssh/sshd_config.d/99-alchemy-k3s.conf",
    ]);
    expect(userData).toContain("HostKey /etc/ssh/ssh_host_ed25519_key");
    expect(userData).toContain("PasswordAuthentication no");
    expect(userData).toContain("PermitRootLogin prohibit-password");
    expect(userData).toContain("generation-2");
    expect(userData).not.toContain("curl");
  });
});
