import { describe, expect, it, vi } from "vitest";
import {
  inspectCloudflare,
  KAIROS_ENDPOINT,
  validateDnsOwnership,
  validateKairosTarget,
  validatePublicHosts,
} from "./preflight.ts";
import { kairosIngressPolicy } from "./ingress-policy.ts";

describe("Kairos target and host boundaries", () => {
  it("accepts only the explicit Kairos context and verified API address", () => {
    expect(() =>
      validateKairosTarget({
        "current-context": "kairos",
        clusters: [{ cluster: { server: KAIROS_ENDPOINT } }],
      }),
    ).not.toThrow();
    for (const context of ["prod-eks", "acc-eks", "default", undefined]) {
      expect(() =>
        validateKairosTarget({
          ...(context ? { "current-context": context } : {}),
          clusters: [{ cluster: { server: KAIROS_ENDPOINT } }],
        }),
      ).toThrow("Refusing cluster operation");
    }
    for (const server of [
      "https://127.0.0.1:6443",
      "https://192.168.178.86:6443",
      undefined,
    ]) {
      expect(() =>
        validateKairosTarget({
          "current-context": "kairos",
          clusters: [{ cluster: server ? { server } : {} }],
        }),
      ).toThrow();
    }
    expect(() =>
      validateKairosTarget({
        "current-context": "kairos",
        clusters: [
          {
            cluster: {
              server: KAIROS_ENDPOINT,
              "insecure-skip-tls-verify": true,
            },
          },
        ],
      }),
    ).toThrow();
  });
  it("rejects nested, wildcard, foreign, empty and duplicate hostname registrations", () => {
    expect(
      validatePublicHosts(["test.openmdta.com", "app-2.openmdta.com"]),
    ).toHaveLength(2);
    for (const hosts of [
      [],
      ["*.openmdta.com"],
      ["app.test.openmdta.com"],
      ["openmdta.com"],
      ["example.com"],
      ["-app.openmdta.com"],
      ["app.openmdta.com", "app.openmdta.com"],
    ])
      expect(() => validatePublicHosts(hosts)).toThrow();
  });
  it("gates CREATE and UPDATE, including legacy class selection, with fail-closed admission", () => {
    const { spec } = kairosIngressPolicy(["test.openmdta.com"]);
    expect(spec.failurePolicy).toBe("Fail");
    expect(spec.matchConstraints.resourceRules[0]?.operations).toEqual([
      "CREATE",
      "UPDATE",
    ]);
    expect(spec.matchConditions[0]?.expression).toContain(
      "kubernetes.io/ingress.class",
    );
    expect(spec.validations[0]?.expression).toContain(
      'r.host in ["test.openmdta.com"]',
    );
    expect(spec.validations[0]?.expression).toContain(
      "size(object.spec.rules) > 0",
    );
  });
});

describe("Cloudflare DNS ownership", () => {
  const host = "test.openmdta.com";
  const cname = { name: host, type: "CNAME", content: "id.cfargotunnel.com" };
  const owner = {
    name: `_ctic_managed.${host}`,
    type: "TXT",
    content: JSON.stringify({
      controller: "strrl.dev/cloudflare-tunnel-ingress-controller",
      tunnel: "kairos",
    }),
  };
  it("allows a free hostname and an already owned tunnel route", () => {
    expect(() => validateDnsOwnership(host, [])).not.toThrow();
    expect(() =>
      validateDnsOwnership(host, [cname, owner], "id"),
    ).not.toThrow();
  });
  it("refuses takeover, repointed records and foreign ownership markers", () => {
    for (const records of [
      [cname],
      [{ ...cname, type: "A", content: "192.0.2.1" }],
      [cname, { ...owner, content: "foreign" }],
      [{ ...cname, content: "other.cfargotunnel.com" }, owner],
      [cname, { ...owner, content: owner.content.replace("kairos", "other") }],
    ])
      expect(() => validateDnsOwnership(host, records, "id")).toThrow(
        "Refusing existing DNS",
      );
  });
  it("stops on rejected Cloudflare credentials without revealing them", async () => {
    const token = "secret-canary";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: false }), { status: 403 }),
      );
    await expect(
      inspectCloudflare("a".repeat(32), token, [host], fetchImpl),
    ).rejects.toThrow("HTTP 403");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBeUndefined();
  });
  it("checks DNS ownership before Access or any resource deployment", async () => {
    const results = [
      [{ name: "openmdta.com", id: "zone", account: { id: "a".repeat(32) } }],
      [],
      [cname],
      [],
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ success: true, result: results.shift() }),
          ),
      );
    await expect(
      inspectCloudflare("a".repeat(32), "token", [host], fetchImpl),
    ).rejects.toThrow("Refusing existing DNS");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
