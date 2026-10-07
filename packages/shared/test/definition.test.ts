import { describe, expect, it } from "vitest";
import {
  assertSameMinor,
  isInsideUpdateWindow,
  normalizeK3sDefinition,
} from "../src/definition.ts";

describe("K3s definitions", () => {
  it("applies safe network and addon defaults", () => {
    expect(
      normalizeK3sDefinition({
        channel: "v1.35",
        updateWindow: {
          days: ["Sunday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "Europe/Berlin",
        },
      }),
    ).toMatchObject({
      channel: "v1.35",
      clusterCidr: "10.244.0.0/16",
      serviceCidr: "10.43.0.0/16",
      clusterDns: "10.43.0.10",
      addons: { traefik: true, metricsServer: true, traefikValues: {} },
    });
  });

  it("renders validated kubelet image GC thresholds and extra flags", () => {
    const definition = {
      channel: "v1.35" as const,
      updateWindow: {
        days: ["Sunday" as const],
        startTime: "02:00" as const,
        endTime: "04:00" as const,
        timeZone: "Europe/Berlin",
      },
    };
    expect(normalizeK3sDefinition(definition).kubeletArgs).toEqual([]);
    expect(
      normalizeK3sDefinition({
        ...definition,
        kubelet: {
          imageGc: { highThresholdPercent: 60, lowThresholdPercent: 40 },
          extraArgs: ["max-pods=150"],
        },
      }).kubeletArgs,
    ).toEqual([
      "image-gc-high-threshold=60",
      "image-gc-low-threshold=40",
      "max-pods=150",
    ]);
    for (const imageGc of [
      { highThresholdPercent: 40, lowThresholdPercent: 60 },
      { highThresholdPercent: 60, lowThresholdPercent: 60 },
      { highThresholdPercent: 101, lowThresholdPercent: 40 },
      { highThresholdPercent: 60.5, lowThresholdPercent: 40 },
      { highThresholdPercent: 60, lowThresholdPercent: -1 },
    ]) {
      expect(() =>
        normalizeK3sDefinition({ ...definition, kubelet: { imageGc } }),
      ).toThrow(/kubelet.imageGc/);
    }
    for (const arg of ["--max-pods=150", "max-pods", "max pods=1"]) {
      expect(() =>
        normalizeK3sDefinition({
          ...definition,
          kubelet: { extraArgs: [arg] },
        }),
      ).toThrow(/name=value/);
    }
    for (const arg of [
      "cloud-provider=external",
      "provider-id=hcloud://1",
      "image-gc-high-threshold=90",
    ]) {
      expect(() =>
        normalizeK3sDefinition({
          ...definition,
          kubelet: { extraArgs: [arg] },
        }),
      ).toThrow(/manages/);
    }
  });

  it("accepts Traefik Helm values only as JSON objects with Traefik enabled", () => {
    const definition = {
      channel: "v1.35" as const,
      updateWindow: {
        days: ["Sunday" as const],
        startTime: "02:00" as const,
        endTime: "04:00" as const,
        timeZone: "Europe/Berlin",
      },
    };
    expect(
      normalizeK3sDefinition({
        ...definition,
        addons: { traefikValues: { ports: { web: { exposedPort: 80 } } } },
      }).addons.traefikValues,
    ).toEqual({ ports: { web: { exposedPort: 80 } } });
    expect(() =>
      normalizeK3sDefinition({
        ...definition,
        addons: { traefik: false, traefikValues: { ports: {} } },
      }),
    ).toThrow(/requires addons.traefik/);
    for (const traefikValues of [
      [],
      { timeout: Number.NaN },
      { hook: () => 1 },
    ]) {
      expect(() =>
        normalizeK3sDefinition({
          ...definition,
          addons: { traefikValues: traefikValues as Record<string, unknown> },
        }),
      ).toThrow(/plain JSON object/);
    }
  });

  it("rejects floating channels and invalid windows", () => {
    expect(() =>
      normalizeK3sDefinition({
        channel: "stable" as "v1.35",
        updateWindow: {
          days: [],
          startTime: "2:00",
          endTime: "2:00",
          timeZone: "Somewhere/Unknown",
        },
      }),
    ).toThrow(/pin one minor/);
  });

  it("evaluates ordinary and overnight windows in their IANA zone", () => {
    const overnight = {
      days: ["Monday" as const],
      startTime: "23:00" as const,
      endTime: "02:00" as const,
      timeZone: "Europe/Berlin",
    };
    expect(
      isInsideUpdateWindow(overnight, new Date("2026-08-24T21:30:00Z")),
    ).toBe(true);
    expect(
      isInsideUpdateWindow(overnight, new Date("2026-08-24T23:30:00Z")),
    ).toBe(true);
    expect(
      isInsideUpdateWindow(overnight, new Date("2026-08-25T01:00:00Z")),
    ).toBe(false);
  });

  it("allows patches but rejects automatic minor changes", () => {
    expect(() => assertSameMinor("v1.35.1+k3s1", "v1.35.2+k3s1")).not.toThrow();
    expect(() => assertSameMinor("v1.34.9+k3s1", "v1.35.0+k3s1")).toThrow(
      /cannot change Kubernetes minor/,
    );
  });

  it("rejects invalid or overlapping Kubernetes networks", () => {
    expect(() =>
      normalizeK3sDefinition({
        channel: "v1.35",
        updateWindow: {
          days: ["Monday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "UTC",
        },
        clusterCidr: "10.43.0.0/16",
        serviceCidr: "10.43.0.0/16",
      }),
    ).toThrow(/must not overlap/);
    expect(() =>
      normalizeK3sDefinition({
        channel: "v1.35",
        updateWindow: {
          days: ["Monday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "UTC",
        },
        clusterDns: "999.43.0.10",
      }),
    ).toThrow(/clusterDns/);
  });
});
