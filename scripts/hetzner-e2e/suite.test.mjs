import { describe, expect, it } from "vitest";
import {
  PROFILES,
  baselineDesired,
  expectedServerCount,
  renderClusterConfig,
} from "./profiles.mjs";
import {
  inventoryIds,
  loadBalancerIpv4,
  parseCliArgs,
  percentileSummary,
  phaseRank,
  resolveCredentials,
  summarizeServer,
} from "./harness.mjs";

describe("Hetzner E2E profiles", () => {
  it("requires an explicit known profile", () => {
    expect(() => parseCliArgs([])).toThrow(/Unknown or missing --profile/);
    expect(() => parseCliArgs(["--profile", "unknown"])).toThrow(
      /Unknown or missing --profile/,
    );
    expect(parseCliArgs(["--profile", "worker-x86", "--yes"])).toEqual({
      profile: "worker-x86",
      yes: true,
      runId: undefined,
    });
  });

  it("defines the intended coverage topologies", () => {
    expect(Object.keys(PROFILES)).toEqual([
      "single-x86",
      "worker-x86",
      "ha-x86",
    ]);
    expect(
      expectedServerCount("single-x86", baselineDesired("single-x86")),
    ).toBe(1);
    expect(
      expectedServerCount("worker-x86", baselineDesired("worker-x86")),
    ).toBe(2);
    expect(expectedServerCount("ha-x86", baselineDesired("ha-x86"))).toBe(6);
  });

  it("renders only profile-owned mutable worker settings", () => {
    const desired = baselineDesired("worker-x86");
    desired.workerPools[0].count = 2;
    desired.workerPools[0].replacementToken = "generation-2";
    const config = renderClusterConfig("worker-x86", desired, [
      "192.0.2.10/32",
    ]);
    expect(config.controlPlane).toEqual({
      count: 1,
      serverType: "cx23",
      locations: ["nbg1"],
    });
    expect(config.workerPools[0].count).toBe(2);
    expect(config.workerPools[0].replacementToken).toBe("generation-2");
    expect(config.allowedCidrs).toEqual(["192.0.2.10/32"]);
    expect(config.clusterId).toBe(config.resourceId);
  });
});

describe("Hetzner E2E safety helpers", () => {
  it("maps the API key without choosing between conflicting projects", () => {
    expect(resolveCredentials({ HETZNER_API_KEY: "secret" })).toEqual({
      token: "secret",
      source: "HETZNER_API_KEY",
    });
    expect(
      resolveCredentials({
        HETZNER_API_KEY: "secret",
        HCLOUD_TOKEN: "secret",
      }),
    ).toEqual({ token: "secret", source: "HCLOUD_TOKEN" });
    expect(() =>
      resolveCredentials({
        HETZNER_API_KEY: "project-a",
        HCLOUD_TOKEN: "project-b",
      }),
    ).toThrow(/differ/);
  });

  it("compares stable inventory identities independent of API order", () => {
    expect(
      inventoryIds({
        servers: [{ id: 4 }, { id: 2 }],
        networks: [{ id: 8 }],
        firewalls: [{ id: 6 }],
        loadBalancers: [{ id: 10 }],
      }),
    ).toEqual({
      servers: [2, 4],
      networks: [8],
      firewalls: [6],
      loadBalancers: [10],
    });
  });

  it("uses the current top-level Hetzner server location shape", () => {
    expect(
      summarizeServer({
        id: 42,
        name: "worker",
        status: "running",
        labels: { "k3s.pool": "nbg" },
        server_type: { name: "cx23" },
        datacenter: null,
        location: { name: "nbg1" },
        public_net: { ipv4: { ip: "192.0.2.42" } },
        protection: { delete: true, rebuild: true },
      }),
    ).toMatchObject({ id: 42, location: "nbg1", serverType: "cx23" });
  });

  it("uses the current nested Hetzner load-balancer address shape", () => {
    expect(
      loadBalancerIpv4({ public_net: { ipv4: { ip: "192.0.2.50" } } }),
    ).toBe("192.0.2.50");
    expect(loadBalancerIpv4({ ipv4: "192.0.2.51" })).toBe("192.0.2.51");
  });

  it("summarizes noisy measurements without defining pass thresholds", () => {
    expect(percentileSummary([5, 1, 2, 4, 3])).toEqual({
      samples: 5,
      min: 1,
      mean: 3,
      p50: 3,
      p95: 5,
      p99: 5,
      max: 5,
    });
  });

  it("orders resumable stable phases and rejects transition names", () => {
    expect(phaseRank("created")).toBeLessThan(phaseRank("upgraded"));
    expect(phaseRank("protection-verified")).toBe(9);
    expect(phaseRank("scaling-up")).toBe(-1);
  });
});
