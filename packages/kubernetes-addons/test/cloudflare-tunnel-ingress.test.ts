import { describe, expect, it } from "vitest";
import {
  cloudflareTunnelHelmValues,
  cloudflareTunnelTokenPolicies,
} from "../src/cloudflare-tunnel-ingress.ts";

describe("Cloudflare tunnel ingress", () => {
  it("keeps DNS privileges in one zone and tunnel privileges in one account", () => {
    const policies = cloudflareTunnelTokenPolicies("account", "zone");
    expect(policies[0]?.resources).toEqual({
      "com.cloudflare.api.account.zone.zone": "*",
    });
    expect(policies[1]?.resources).toEqual({
      "com.cloudflare.api.account.account": "*",
    });
    expect(policies[1]?.permissionGroups).toEqual(["Cloudflare Tunnel Write"]);
    expect(JSON.stringify(policies)).not.toContain("Access:");
  });
  it("uses secret references, explicit ingress selection and single-node scheduling", () => {
    const values = cloudflareTunnelHelmValues(
      "tunnel",
      "credentials",
      "rv-1",
      "policy-1",
    );
    expect(values).toMatchObject({
      cloudflare: {
        secretRef: {
          name: "credentials",
          apiTokenKey: "api-token",
          accountIDKey: "account-id",
          tunnelNameKey: "tunnel-name",
        },
      },
      ingressClass: { name: "cloudflare-tunnel", isDefaultClass: false },
      replicaCount: 1,
      cloudflared: { replicaCount: 1, podAntiAffinity: false },
    });
    expect(values.cloudflare).not.toHaveProperty("apiToken");
    expect(values.podAnnotations).toEqual({
      "alchemy.run/secret-revision": "rv-1",
      "alchemy.run/dependency": "policy-1",
    });
    expect(
      cloudflareTunnelHelmValues("tunnel", "credentials", "rv-2")
        .podAnnotations,
    ).not.toEqual(values.podAnnotations);
  });
});
