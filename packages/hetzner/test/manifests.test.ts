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
    expect(script).toContain("secret");
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
