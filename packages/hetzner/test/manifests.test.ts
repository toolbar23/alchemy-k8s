import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import { systemUpgradePlans } from "../src/manifests.ts";
import { buildInstallScript, nodeName } from "../src/node.ts";
import type { NodeProps } from "../src/types.ts";

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

  it("builds a production server install with embedded etcd and S3 snapshots", () => {
    const props: NodeProps = {
      name: "test-cp-1",
      role: "server",
      initialServer: true,
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
    expect(script).toContain("'--etcd-s3-bucket-lookup-type' 'path'");
    expect(script).toContain("secret");
  });

  it("gives replacement generations different Kubernetes node names", () => {
    const logical =
      "a-very-long-worker-name-that-needs-to-fit-inside-a-kubernetes-dns-label";
    expect(nodeName(logical, 123)).not.toBe(nodeName(logical, 456));
    expect(nodeName(logical, 123)).toHaveLength(63);
  });
});
