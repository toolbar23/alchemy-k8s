import { describe, expect, it } from "vitest";
import {
  api,
  helmTemplateArgs,
  normalizeConfigGroupObjects,
  parseKubernetesYaml,
} from "../src/index.ts";
import schemaLock from "../schema.lock.json" with { type: "json" };

describe("generated Kubernetes API", () => {
  it("pins and exposes the planned stable built-ins and patches", () => {
    expect(schemaLock.version).toBe("5.1.0");
    expect(schemaLock.resources).toHaveLength(39);
    expect(api.apps.v1.StatefulSet).toBeTypeOf("function");
    expect(api.apps.v1.StatefulSetPatch).toBeTypeOf("function");
    expect(api.apps.v1.DaemonSet).toBeTypeOf("function");
    expect(api.batch.v1.CronJob).toBeTypeOf("function");
    expect(api.storage.v1.StorageClass).toBeTypeOf("function");
    expect(api.core.v1).not.toHaveProperty("Secret");
  });
});

describe("ConfigGroup", () => {
  it("parses multiple documents and Lists, defaults namespaces, and orders prerequisites", () => {
    const parsed = parseKubernetesYaml(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Namespace
    metadata:
      name: apps
  - apiVersion: v1
    kind: Service
    metadata:
      name: api
`);
    const normalized = normalizeConfigGroupObjects({
      objects: parsed,
      defaultNamespace: "apps",
    });
    expect(normalized.map(({ kind }) => kind)).toEqual([
      "Namespace",
      "Service",
      "Deployment",
    ]);
    expect(normalized[0]?.metadata.namespace).toBeUndefined();
    expect(normalized[1]?.metadata.namespace).toBe("apps");
    expect(normalized[2]?.metadata.namespace).toBe("apps");
  });

  it("refuses Secret documents before resource registration", () => {
    expect(() =>
      normalizeConfigGroupObjects({
        yaml: `
apiVersion: v1
kind: Secret
metadata:
  name: credentials
stringData:
  token: secret-canary
`,
      }),
    ).toThrow("KubernetesAddons.Secret");
  });
});

describe("Helm rendering", () => {
  it("uses execFile arguments and stdin values rather than a shell or temp file", () => {
    expect(
      helmTemplateArgs("Controller", {
        chart: "controller",
        releaseName: "controller",
        namespace: "system",
        repository: "https://charts.example.test",
        version: "1.2.3",
        apiVersions: ["example.io/v1"],
      }),
    ).toEqual([
      "template",
      "controller",
      "controller",
      "--skip-tests",
      "--namespace",
      "system",
      "--include-crds",
      "--repo",
      "https://charts.example.test",
      "--version",
      "1.2.3",
      "--api-versions",
      "example.io/v1",
      "--values",
      "-",
    ]);
  });
});
