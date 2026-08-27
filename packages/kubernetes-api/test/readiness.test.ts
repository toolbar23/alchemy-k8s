import { describe, expect, it } from "vitest";
import {
  jsonPathValue,
  kubernetesObjectReadiness,
  type KubernetesObject,
} from "../src/index.ts";

const object = (
  kind: string,
  fields: Partial<KubernetesObject>,
): KubernetesObject => ({
  apiVersion: "v1",
  kind,
  metadata: { name: "test", uid: "uid-test", generation: 2 },
  ...fields,
});

describe("Kubernetes readiness", () => {
  it("covers workloads, jobs, storage, load balancers, namespaces, and CRDs", () => {
    expect(
      kubernetesObjectReadiness(
        object("Deployment", {
          spec: { replicas: 2 },
          status: { observedGeneration: 2, availableReplicas: 2 },
        }),
      ).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(
        object("StatefulSet", {
          spec: { replicas: 2 },
          status: { observedGeneration: 2, readyReplicas: 1 },
        }),
      ).ready,
    ).toBe(false);
    expect(
      kubernetesObjectReadiness(
        object("Job", {
          status: { conditions: [{ type: "Complete", status: "True" }] },
        }),
      ).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(
        object("PersistentVolumeClaim", { status: { phase: "Bound" } }),
      ).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(
        object("Service", {
          spec: { type: "LoadBalancer" },
          status: { loadBalancer: { ingress: [{ ip: "192.0.2.1" }] } },
        }),
      ).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(
        object("Namespace", { status: { phase: "Active" } }),
      ).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(
        object("CustomResourceDefinition", {
          status: {
            conditions: [{ type: "Established", status: "True" }],
          },
        }),
      ).ready,
    ).toBe(true);
  });

  it("supports condition and bounded JSONPath waits", () => {
    const custom = object("Widget", {
      status: {
        phase: "Serving",
        conditions: [{ type: "Ready", status: "True" }],
      },
    });
    expect(
      kubernetesObjectReadiness(custom, { condition: "Ready" }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness(custom, {
        jsonPath: "{.status.phase}",
        equals: "Serving",
      }).ready,
    ).toBe(true);
    expect(jsonPathValue(custom, "$.status.phase")).toBe("Serving");
  });

  it("never treats a zero-valued watch bookmark as a ready workload", () => {
    expect(
      kubernetesObjectReadiness({
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: { name: "" },
        spec: { replicas: 0 },
        status: { readyReplicas: 0 },
      }).ready,
    ).toBe(false);
  });
});
