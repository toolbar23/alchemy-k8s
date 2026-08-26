import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import {
  EXTERNAL_DNS_CHART_VERSION,
  EXTERNAL_DNS_IMAGE,
  cloudflareExternalDnsOwnerId,
  cloudflareExternalDnsTokenPolicies,
  planCloudflareExternalDns,
  validateCloudflareExternalDnsProps,
  type CloudflareExternalDnsProps,
} from "../src/cloudflare-external-dns.ts";

const acceptsCluster = (
  _cluster: CloudflareExternalDnsProps["cluster"],
): void => undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

const zone = {
  zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
  domain: "example.com",
};

const plan = (overrides: Record<string, unknown> = {}) =>
  planCloudflareExternalDns({
    ...zone,
    policy: "sync",
    proxied: true,
    releaseName: "external-dns",
    txtOwnerId: "production-external-dns-aabbccdd",
    secretName: "external-dns-token",
    namespaceRevision: "namespace-1",
    secretRevision: "secret-2",
    ...overrides,
  });

describe("KubernetesAddons.CloudflareExternalDns", () => {
  it("scopes the managed token to exactly one zone", () => {
    expect(cloudflareExternalDnsTokenPolicies(zone.zoneId)).toEqual([
      {
        effect: "allow",
        permissionGroups: ["Zone Read", "DNS Read", "DNS Write"],
        resources: {
          "com.cloudflare.api.account.zone.023e105f4ecef8ad9ca31a8372d0c353":
            "*",
        },
      },
    ]);
    expect(
      JSON.stringify(cloudflareExternalDnsTokenPolicies(zone.zoneId)),
    ).not.toContain("zone.*");
  });

  it("pins a secured Cloudflare controller with exact ownership filters", () => {
    expect(EXTERNAL_DNS_CHART_VERSION).toBe("1.21.1");
    expect(EXTERNAL_DNS_IMAGE).toBe(
      "registry.k8s.io/external-dns/external-dns:v0.21.0@sha256:f53faaf71cb270d1ca9dce6ea0c94bfebf1a18696263487f0fbc74b9bf2bd7ff",
    );
    expect(plan().values).toMatchObject({
      fullnameOverride: "external-dns",
      image: {
        repository: "registry.k8s.io/external-dns/external-dns",
        tag: "v0.21.0@sha256:f53faaf71cb270d1ca9dce6ea0c94bfebf1a18696263487f0fbc74b9bf2bd7ff",
        pullPolicy: "IfNotPresent",
      },
      replicaCount: 1,
      deploymentStrategy: { type: "Recreate" },
      provider: { name: "cloudflare" },
      sources: ["service", "ingress"],
      policy: "sync",
      registry: "txt",
      txtOwnerId: "production-external-dns-aabbccdd",
      domainFilters: ["example.com"],
      triggerLoopOnEvent: true,
      extraArgs: {
        "zone-id-filter": zone.zoneId,
        "cloudflare-proxied": true,
        "cloudflare-dns-records-per-page": 5000,
      },
      env: [
        {
          name: "CF_API_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "external-dns-token",
              key: "api-token",
            },
          },
        },
      ],
      serviceAccount: {
        create: true,
        automountServiceAccountToken: true,
      },
      automountServiceAccountToken: true,
      rbac: { create: true },
      namespaced: false,
      securityContext: {
        privileged: false,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        capabilities: { drop: ["ALL"] },
      },
      podAnnotations: {
        "alchemy.run/namespace-revision": "namespace-1",
        "alchemy.run/secret-revision": "secret-2",
      },
    });
  });

  it("keeps tokens out of Helm values and rolls on safe revisions", () => {
    const canary = Redacted.make("cloudflare-token-canary");
    const rendered = plan({ tokenRevision: "rotation-3" });
    expect(JSON.stringify(rendered.values)).not.toContain(
      Redacted.value(canary),
    );
    expect(rendered.values).toMatchObject({
      podAnnotations: {
        "alchemy.run/secret-revision": "secret-2",
        "alchemy.run/token-revision": "rotation-3",
      },
    });
    expect(rendered.values).not.toHaveProperty("secretConfiguration");
  });

  it("applies upsert-only and DNS-only behavior explicitly", () => {
    expect(
      plan({ policy: "upsert-only", proxied: false }).values,
    ).toMatchObject({
      policy: "upsert-only",
      extraArgs: { "cloudflare-proxied": false },
    });
  });

  it("derives stable and distinct TXT owner IDs", () => {
    const first = cloudflareExternalDnsOwnerId(
      "production",
      "prod",
      "PublicDns",
    );
    expect(first).toBe(
      cloudflareExternalDnsOwnerId("production", "prod", "PublicDns"),
    );
    expect(first).not.toBe(
      cloudflareExternalDnsOwnerId("production", "prod", "InternalDns"),
    );
    expect(first).not.toBe(
      cloudflareExternalDnsOwnerId("production", "staging", "PublicDns"),
    );
    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/^[a-z0-9-]+-[a-f0-9]{12}$/);
  });

  it("requires an explicit safe policy and valid names", () => {
    const base = {
      cluster: {} as never,
      zone: {} as never,
      policy: "sync" as const,
    };
    expect(() =>
      validateCloudflareExternalDnsProps({
        ...base,
        policy: "create-only" as never,
      }),
    ).toThrow("sync or upsert-only");
    expect(() =>
      validateCloudflareExternalDnsProps({
        ...base,
        namespace: "Not_A_Name",
      }),
    ).toThrow("Invalid ExternalDNS namespace");
    expect(() =>
      validateCloudflareExternalDnsProps({
        ...base,
        tokenRevision: "",
      }),
    ).toThrow("tokenRevision must not be empty");
    expect(() =>
      validateCloudflareExternalDnsProps({ ...base, timeoutSeconds: 0 }),
    ).toThrow("timeoutSeconds must be greater than zero");
  });
});
