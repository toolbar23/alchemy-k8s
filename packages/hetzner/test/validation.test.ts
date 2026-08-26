import { describe, expect, it } from "vitest";
import {
  cidrContains,
  networkZoneFor,
  normalizeLocations,
  validateClusterProps,
} from "../src/validation.ts";

describe("Hetzner topology validation", () => {
  it("checks runner IPv4 membership without accepting adjacent ranges", () => {
    expect(cidrContains("203.0.113.0/24", "203.0.113.42")).toBe(true);
    expect(cidrContains("203.0.113.0/24", "203.0.114.42")).toBe(false);
  });

  it("normalizes a shared control-plane location", () => {
    expect(
      normalizeLocations({
        k3s: {} as never,
        controlPlane: { count: 3, serverType: "cpx22", locations: "nbg1" },
        workerPools: [],
        ssh: { allowedCidrs: ["203.0.113.1/32"] },
      }),
    ).toEqual(["nbg1", "nbg1", "nbg1"]);
  });

  it("rejects locations from different private-network zones", () => {
    expect(() => networkZoneFor(["nbg1", "ash"])).toThrow(
      /same Hetzner network zone/,
    );
  });

  it("allows zero public CIDRs only in private management mode", () => {
    const props = {
      k3s: {} as never,
      controlPlane: {
        count: 1 as const,
        serverType: "cx23",
        locations: "nbg1",
      },
      workerPools: [],
      scheduleWorkloadsOnControlPlane: true,
      ssh: { allowedCidrs: [], privateOnly: true },
    };
    expect(() => validateClusterProps(props)).not.toThrow();
    expect(() =>
      validateClusterProps({ ...props, ssh: { allowedCidrs: [] } }),
    ).toThrow("explicitly allow");
  });

  it("requires S3 and a bounded age for automatic recovery", () => {
    const props = {
      k3s: {} as never,
      controlPlane: {
        count: 1 as const,
        serverType: "cx23",
        locations: "nbg1",
      },
      workerPools: [],
      scheduleWorkloadsOnControlPlane: true,
      ssh: { allowedCidrs: ["203.0.113.1/32"] },
      recovery: {
        restoreOnInitialControlPlaneReplacement: true as const,
        maximumSnapshotAge: 0,
      },
    };
    expect(() => validateClusterProps(props)).toThrow("etcdSnapshots.s3");
  });
});
