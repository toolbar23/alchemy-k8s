import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import {
  CERT_MANAGER_CHART,
  CERT_MANAGER_CHART_VERSION,
  certManagerHelmValues,
  validateCertManagerProps,
  type CertManagerProps,
} from "../src/cert-manager.ts";

const acceptsCluster = (_cluster: CertManagerProps["cluster"]): void =>
  undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

describe("KubernetesAddons.CertManager", () => {
  it("pins the upstream OCI chart and owns CRDs without Helm hooks", () => {
    expect(CERT_MANAGER_CHART).toBe(
      "oci://quay.io/jetstack/charts/cert-manager",
    );
    expect(CERT_MANAGER_CHART_VERSION).toBe("v1.21.1");
    expect(certManagerHelmValues("cert-manager", "namespace-1")).toMatchObject({
      crds: { enabled: true, keep: true },
      startupapicheck: { enabled: false },
      global: {
        leaderElection: { namespace: "cert-manager" },
        rbac: { create: true, aggregateClusterRoles: false },
      },
      replicaCount: 1,
      podAnnotations: {
        "alchemy.run/namespace-revision": "namespace-1",
      },
      webhook: { replicaCount: 1, timeoutSeconds: 10 },
      cainjector: { enabled: true, replicaCount: 1 },
    });
  });

  it("hardens every long-running component", () => {
    const values = certManagerHelmValues("cert-manager", "namespace-1");
    for (const component of [
      values,
      values.webhook as Record<string, unknown>,
      values.cainjector as Record<string, unknown>,
    ]) {
      expect(component).toMatchObject({
        automountServiceAccountToken: true,
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containerSecurityContext: {
          privileged: false,
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
      });
    }
  });

  it("keeps the v1 surface opinionated and validates operational names", () => {
    expect(
      Object.keys(certManagerHelmValues("cert-manager", "namespace-1")),
    ).not.toContain("values");
    expect(() =>
      validateCertManagerProps({
        cluster: {} as never,
        namespace: "Not_A_Name",
      }),
    ).toThrow("Invalid cert-manager namespace");
    expect(() =>
      validateCertManagerProps({
        cluster: {} as never,
        releaseName: "Not_A_Name",
      }),
    ).toThrow("Invalid cert-manager release name");
    expect(() =>
      validateCertManagerProps({ cluster: {} as never, timeoutSeconds: 0 }),
    ).toThrow("greater than zero");
  });
});
