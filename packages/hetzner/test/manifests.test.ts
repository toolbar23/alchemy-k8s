import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import {
  buildAddonScript,
  hasObservableClusterState,
} from "../src/cluster-state.ts";
import {
  HCCM_MANIFEST,
  HCCM_VERSION,
  SYSTEM_UPGRADE_CONTROLLER_MANIFEST,
  systemUpgradePlans,
} from "../src/manifests.ts";
import {
  buildInstallScript,
  createNodeReconcileLimiter,
  nodeName,
  providerIdPatchCommand,
} from "../src/node.ts";
import * as Effect from "effect/Effect";
import type { ClusterStateProps, NodeProps } from "../src/types.ts";
import { productionStateWarning } from "../src/cluster.ts";
import {
  buildPrepareSecretsEncryptionScript,
  parseSecretsEncryptionStatus,
  secretsEncryptionArguments,
  supportsExistingClusterMigration,
  supportsSecretbox,
} from "../src/secrets-encryption.ts";

const definition = normalizeK3sDefinition({
  channel: "v1.35",
  updateWindow: {
    days: ["Saturday", "Sunday"],
    startTime: "02:00",
    endTime: "04:00",
    timeZone: "Europe/Berlin",
  },
});

describe("Hetzner bootstrap", () => {
  it("pins System Upgrade Controller plans to the chosen minor and window", () => {
    const plans = systemUpgradePlans(definition);
    expect(plans).toContain("channels/v1.35");
    expect(plans).toContain("days: [sat, sun]");
    expect(plans).toContain('timeZone: "Europe/Berlin"');
    expect(plans).toContain('args: ["prepare", "k3s-server"]');
  });

  it("waits for the System Upgrade Plan CRD before applying plans", () => {
    const script = buildAddonScript({
      hcloudToken: Redacted.make("token"),
      networkName: "test-network",
      networkZone: "eu-central",
      k3s: definition,
    } as unknown as ClusterStateProps);
    expect(script).toContain(
      `kubectl apply -f ${JSON.stringify(SYSTEM_UPGRADE_CONTROLLER_MANIFEST)}\nfor attempt in $(seq 1 60); do\n`,
    );
    expect(script).toContain(
      `done\nkubectl wait --for=condition=Established crd/plans.upgrade.cattle.io --timeout=5m\nprintf %s`,
    );
  });

  it("pins HCCM independently from the Kubernetes minor", () => {
    const script = buildAddonScript({
      hcloudToken: Redacted.make("token"),
      networkName: "test-network",
      networkZone: "eu-central",
      k3s: { ...definition, channel: "v1.36" },
    } as unknown as ClusterStateProps);
    expect(HCCM_MANIFEST).toContain(`/download/${HCCM_VERSION}/`);
    expect(script).toContain(HCCM_MANIFEST);
    expect(script).not.toContain("/download/v1.36.0/ccm-networks.yaml");
  });

  it("treats a partially persisted cluster create as not yet observable", () => {
    expect(
      hasObservableClusterState({
        controlPlanes: [null],
        loadBalancer: null,
        nodeServerIds: [null, null],
      } as unknown as ClusterStateProps),
    ).toBe(false);
    expect(
      hasObservableClusterState({
        controlPlanes: [{ server: { id: 1 } }],
        loadBalancer: { ipv4: "192.0.2.2" },
      } as ClusterStateProps),
    ).toBe(true);
  });

  it("builds a production server install with embedded etcd and S3 snapshots", () => {
    const props: NodeProps = {
      name: "test-cp-1",
      role: "server",
      initialServer: true,
      bootstrapRevision: 2,
      server: { id: 1, serverId: 1, name: "cp", ipv4: "203.0.113.1" },
      k3s: definition,
      networkCidr: "10.0.0.0/16",
      apiEndpoint: "203.0.113.2",
      scheduleWorkloadsOnControlPlane: false,
      etcdSnapshots: {
        schedule: "0 * * * *",
        retention: 24,
        s3: {
          endpoint: "s3.example.test",
          region: "eu-central-1",
          bucket: "backups",
          accessKey: Redacted.make("access"),
          secretKey: Redacted.make("secret"),
          forcePathStyle: true,
        },
      },
    };
    const script = buildInstallScript(props, "10.0.0.2", "v1.35.2+k3s1");
    expect(script).toContain("'--cluster-init'");
    expect(script).toContain("'servicelb'");
    expect(script).toContain("awk -v address='10.0.0.2'");
    expect(script).toContain(`'--flannel-iface' "$private_interface"`);
    expect(script).toContain("'--kubelet-arg' 'provider-id=hcloud://1'");
    expect(script).toContain("'--etcd-s3-bucket-lookup-type' 'path'");
    expect(script).toContain("'--secrets-encryption'");
    expect(script).toContain("'--secrets-encryption-provider' 'secretbox'");
    expect(script).toContain("secret");
  });

  it("starts agents without waiting for the external cloud controller", () => {
    const script = buildInstallScript(
      {
        name: "test-worker-1",
        role: "agent",
        initialServer: false,
        bootstrapRevision: 2,
        server: { id: 2, serverId: 2, name: "worker", ipv4: "203.0.113.2" },
        bootstrap: {
          logicalName: "test-cp-1",
          name: "test-cp-1",
          role: "server",
          serverId: 1,
          privateIp: "10.0.0.2",
          version: "v1.35.7+k3s1",
          token: Redacted.make("token"),
          server: { id: 1, serverId: 1, name: "cp", ipv4: "203.0.113.1" },
        },
        k3s: definition,
        networkCidr: "10.0.0.0/16",
        apiEndpoint: "203.0.113.3",
        scheduleWorkloadsOnControlPlane: false,
        etcdSnapshots: { schedule: "0 * * * *", retention: 24 },
      },
      "10.0.0.3",
      "v1.35.7+k3s1",
    );
    expect(script).toContain("INSTALL_K3S_SKIP_START='true'");
    expect(script).toContain("systemctl start --no-block k3s-agent");
  });

  it("uses version-gated Secret encryption and parses K3s status safely", () => {
    expect(supportsSecretbox("v1.30.11+k3s1")).toBe(false);
    expect(supportsSecretbox("v1.30.12+k3s1")).toBe(true);
    expect(supportsSecretbox("v1.31.8+k3s1")).toBe(true);
    expect(supportsSecretbox("v1.32.4+k3s1")).toBe(true);
    expect(supportsSecretbox("v1.33.0+k3s1")).toBe(true);
    expect(secretsEncryptionArguments("v1.29.9+k3s1")).toEqual([
      "--secrets-encryption",
    ]);
    expect(supportsExistingClusterMigration("v1.35.2+k3s1")).toBe(false);
    expect(supportsExistingClusterMigration("v1.35.3+k3s1")).toBe(true);
    expect(supportsExistingClusterMigration("v1.36.0+k3s1")).toBe(true);

    expect(
      parseSecretsEncryptionStatus(`Encryption Status: Enabled
Current Rotation Stage: reencrypt_finished
Server Encryption Hashes: All hashes match
Active  Key Type  Name
------  --------  ----
 *      Secretbox secretboxkey
`),
    ).toEqual({
      enabled: true,
      noConfiguration: false,
      stage: "reencrypt_finished",
      hashesMatch: true,
      provider: "secretbox",
    });
    expect(
      parseSecretsEncryptionStatus(`Encryption Status: Enabled
Current Rotation Stage: start
Server Encryption Hashes: All hashes match

Active  Key Type           Name
------  --------           ----
 *      XSalsa20-POLY1305  secretboxkey
`),
    ).toMatchObject({ enabled: true, provider: "secretbox" });
  });

  it("builds a verified, resumable pre-migration snapshot checkpoint", () => {
    const script = buildPrepareSecretsEncryptionScript("after-snapshot");
    expect(script).toContain("k3s etcd-snapshot save --name");
    expect(script).toContain("k3s etcd-snapshot ls | grep -F");
    expect(script).toContain("-size +0c");
    expect(script).toContain("phase=snapshot_verified");
    expect(script).toContain("exit 97");
    const enabled = buildPrepareSecretsEncryptionScript("after-enable");
    expect(enabled).toContain("k3s secrets-encrypt enable");
    expect(enabled).toContain("phase=prepared");
    expect(enabled).toContain('"enable"');
    expect(enabled).toContain("exit 97");
    const provider = buildPrepareSecretsEncryptionScript(undefined, "provider");
    expect(provider).toContain('"provider"');
    expect(provider).toContain('[ "$recorded_mode" = enable ]');
  });

  it("warns production stages that use plaintext local Alchemy state", () => {
    expect(productionStateWarning("production", "local", "test")).toContain(
      "encrypted remote state backend",
    );
    expect(productionStateWarning("prod-eu", "inmemory", "test")).toContain(
      "Redacted",
    );
    expect(productionStateWarning("dev", "local", "development")).toBe(
      undefined,
    );
    expect(
      productionStateWarning("production", "cloudflare-http", "test"),
    ).toBe(undefined);
  });

  it("gives replacement generations different Kubernetes node names", () => {
    const logical =
      "a-very-long-worker-name-that-needs-to-fit-inside-a-kubernetes-dns-label";
    expect(nodeName(logical, 123)).not.toBe(nodeName(logical, 456));
    expect(nodeName(logical, 123)).toHaveLength(63);
  });

  it("patches existing Kubernetes nodes with their Hetzner provider ID", () => {
    expect(providerIdPatchCommand("worker-1", 123)).toContain(
      `patch node "worker-1" --type=merge -p "{\\"spec\\":{\\"providerID\\":\\"hcloud://123\\"}}"`,
    );
  });

  it("parallelizes fresh joins but serializes existing-node reconciles per cluster", async () => {
    const limitReconcile = createNodeReconcileLimiter();
    let activeFresh = 0;
    let maxFresh = 0;
    let activeExisting = 0;
    let maxExisting = 0;
    const work = (existing: boolean, cluster = "cluster-a") =>
      limitReconcile(
        cluster,
        existing,
        Effect.promise(async () => {
          if (existing) {
            activeExisting += 1;
            maxExisting = Math.max(maxExisting, activeExisting);
          } else {
            activeFresh += 1;
            maxFresh = Math.max(maxFresh, activeFresh);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (existing) activeExisting -= 1;
          else activeFresh -= 1;
        }),
      );

    await Effect.runPromise(
      Effect.all([work(false), work(false)], { concurrency: "unbounded" }),
    );
    await Effect.runPromise(
      Effect.all([work(true), work(true)], { concurrency: "unbounded" }),
    );
    expect(maxExisting).toBe(1);
    activeExisting = 0;
    maxExisting = 0;
    await Effect.runPromise(
      Effect.all([work(true, "cluster-a"), work(true, "cluster-b")], {
        concurrency: "unbounded",
      }),
    );

    expect(maxFresh).toBe(2);
    expect(maxExisting).toBe(2);
  });
});
