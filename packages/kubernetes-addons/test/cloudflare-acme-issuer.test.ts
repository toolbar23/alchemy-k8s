import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import {
  LETSENCRYPT_PRODUCTION_URL,
  LETSENCRYPT_STAGING_URL,
  cloudflareAcmeIssuerManifest,
  cloudflareAcmeIssuerName,
  cloudflareAcmeIssuerTokenPolicies,
  validateCloudflareAcmeIssuerProps,
  type CloudflareAcmeIssuerProps,
} from "../src/cloudflare-acme-issuer.ts";

const acceptsCluster = (_cluster: CloudflareAcmeIssuerProps["cluster"]): void =>
  undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

const manifest = (environment: "staging" | "production" = "staging") =>
  cloudflareAcmeIssuerManifest({
    name: `letsencrypt-${environment}`,
    email: "admin@example.com",
    environment,
    domain: "example.com",
    tokenSecretName: `letsencrypt-${environment}-cloudflare`,
    accountKeySecretName: `letsencrypt-${environment}-account-key`,
    certManagerRevision: "chart-a",
    tokenSecretRevision: "secret-b",
  });

describe("KubernetesAddons.CloudflareAcmeIssuer", () => {
  it("scopes a distinct managed token to one exact zone", () => {
    expect(
      cloudflareAcmeIssuerTokenPolicies("023e105f4ecef8ad9ca31a8372d0c353"),
    ).toEqual([
      {
        effect: "allow",
        permissionGroups: ["Zone Read", "DNS Write"],
        resources: {
          "com.cloudflare.api.account.zone.023e105f4ecef8ad9ca31a8372d0c353":
            "*",
        },
      },
    ]);
    expect(
      JSON.stringify(
        cloudflareAcmeIssuerTokenPolicies("023e105f4ecef8ad9ca31a8372d0c353"),
      ),
    ).not.toContain("zone.*");
  });

  it("uses the staging endpoint and an exact-zone DNS-01 selector", () => {
    expect(LETSENCRYPT_STAGING_URL).toBe(
      "https://acme-staging-v02.api.letsencrypt.org/directory",
    );
    expect(manifest()).toMatchObject({
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: {
        name: "letsencrypt-staging",
        annotations: {
          "alchemy.run/cert-manager-revision": "chart-a",
          "alchemy.run/token-secret-revision": "secret-b",
        },
      },
      spec: {
        acme: {
          email: "admin@example.com",
          server: LETSENCRYPT_STAGING_URL,
          privateKeySecretRef: { name: "letsencrypt-staging-account-key" },
          solvers: [
            {
              selector: { dnsZones: ["example.com"] },
              dns01: {
                cloudflare: {
                  apiTokenSecretRef: {
                    name: "letsencrypt-staging-cloudflare",
                    key: "api-token",
                  },
                },
              },
            },
          ],
        },
      },
    });
  });

  it("selects production explicitly without embedding credentials", () => {
    const token = Redacted.make("cloudflare-acme-token-canary");
    expect(LETSENCRYPT_PRODUCTION_URL).toBe(
      "https://acme-v02.api.letsencrypt.org/directory",
    );
    expect(manifest("production")).toMatchObject({
      spec: { acme: { server: LETSENCRYPT_PRODUCTION_URL } },
    });
    expect(JSON.stringify(manifest("production"))).not.toContain(
      Redacted.value(token),
    );
  });

  it("derives stable Kubernetes names and rejects unsafe inputs", () => {
    expect(cloudflareAcmeIssuerName("PublicCertificates", "staging")).toBe(
      "public-certificates-staging",
    );
    expect(cloudflareAcmeIssuerName("PublicCertificates", "production")).toBe(
      "public-certificates-production",
    );
    const base = {
      cluster: {} as never,
      certManager: {} as never,
      zone: {} as never,
      email: "admin@example.com",
      environment: "staging" as const,
    };
    expect(() =>
      validateCloudflareAcmeIssuerProps({ ...base, email: "not-an-email" }),
    ).toThrow("email must be valid");
    expect(() =>
      validateCloudflareAcmeIssuerProps({ ...base, name: "Not_A_Name" }),
    ).toThrow("Invalid Cloudflare ACME issuer name");
    expect(() =>
      validateCloudflareAcmeIssuerProps({
        ...base,
        environment: "preview" as never,
      }),
    ).toThrow("staging or production");
    expect(() =>
      validateCloudflareAcmeIssuerProps({ ...base, timeoutSeconds: 0 }),
    ).toThrow("timeoutSeconds must be greater than zero");
  });
});
