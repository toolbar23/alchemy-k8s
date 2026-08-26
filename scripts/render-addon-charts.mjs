import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import * as Redacted from "effect/Redacted";
import {
  CERT_MANAGER_CHART,
  CERT_MANAGER_CHART_VERSION,
  EXTERNAL_DNS_CHART_VERSION,
  OTEL_COLLECTOR_CHART_VERSION,
  PARSEABLE_CHART_VERSION,
  certManagerHelmValues,
  parseableHelmValues,
  planCloudflareExternalDns,
  planOtelCollector,
} from "../packages/kubernetes-addons/dist/index.mjs";

const helm = process.env.HELM_BIN ?? process.env.HELM ?? "helm";
const canary = "alchemy-release-secret-canary";
const directory = mkdtempSync(join(tmpdir(), "alchemy-addon-charts-"));

const charts = [
  {
    name: "external-dns",
    chart: "external-dns",
    repo: "https://kubernetes-sigs.github.io/external-dns/",
    version: EXTERNAL_DNS_CHART_VERSION,
    expectedKind: "Deployment",
    values: planCloudflareExternalDns({
      zoneId: "zone-id",
      domain: "example.com",
      policy: "upsert-only",
      proxied: false,
      releaseName: "external-dns",
      txtOwnerId: "release-gate",
      secretName: "cloudflare-token",
      namespaceRevision: "namespace-revision",
      secretRevision: "secret-revision",
    }).values,
  },
  {
    name: "cert-manager",
    chart: CERT_MANAGER_CHART,
    version: CERT_MANAGER_CHART_VERSION,
    includeCrds: true,
    expectedKind: "CustomResourceDefinition",
    values: certManagerHelmValues("cert-manager", "namespace-revision"),
  },
  {
    name: "otel-collector",
    chart: "opentelemetry-collector",
    repo: "https://open-telemetry.github.io/opentelemetry-helm-charts",
    version: OTEL_COLLECTOR_CHART_VERSION,
    expectedKind: "Deployment",
    values: planOtelCollector({
      releaseName: "otel-collector",
      destination: {
        endpoints: {
          traces: {
            url: "https://telemetry.example.com/v1/traces",
            headers: { Authorization: Redacted.make(canary) },
          },
        },
      },
      namespaceRevision: "namespace-revision",
      headerSecretName: "otel-headers",
      headerSecretRevision: "secret-revision",
    }).values,
  },
  {
    name: "parseable",
    chart: "parseable",
    repo: "https://charts.parseable.com",
    version: PARSEABLE_CHART_VERSION,
    expectedKind: "StatefulSet",
    values: parseableHelmValues({
      releaseName: "parseable",
      secretName: "parseable-env",
      secretResourceVersion: "secret-revision",
      forcePathStyle: true,
      staging: { size: "1Gi" },
    }),
  },
];

try {
  for (const chart of charts) {
    const valuesPath = join(directory, `${chart.name}.json`);
    const serializedValues = JSON.stringify(chart.values);
    if (serializedValues.includes(canary)) {
      throw new Error(`${chart.name} Helm values contain the secret canary`);
    }
    writeFileSync(valuesPath, serializedValues);

    const helmArguments = [
      "template",
      chart.name,
      chart.chart,
      "--namespace",
      chart.name,
      "--version",
      chart.version,
      "--values",
      valuesPath,
      ...(chart.repo === undefined ? [] : ["--repo", chart.repo]),
      ...(chart.includeCrds === true ? ["--include-crds"] : []),
    ];
    const rendered = execFileSync(helm, helmArguments, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const renderedAgain = execFileSync(helm, helmArguments, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (renderedAgain !== rendered) {
      throw new Error(`${chart.name} produced a non-idempotent render`);
    }

    if (!rendered.includes(`kind: ${chart.expectedKind}`)) {
      throw new Error(
        `${chart.name} did not render a ${chart.expectedKind} resource`,
      );
    }
    if (rendered.includes(canary)) {
      throw new Error(`${chart.name} rendered the secret canary`);
    }

    const images = [...rendered.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)].map(
      ([, image]) => image,
    );
    if (images.length === 0) {
      throw new Error(`${chart.name} did not render a container image`);
    }
    for (const image of images) {
      if (
        image.endsWith(":latest") ||
        !/(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9][A-Za-z0-9._-]*(?:@sha256:[a-f0-9]{64})?)$/.test(
          image,
        )
      ) {
        throw new Error(`${chart.name} rendered an unpinned image: ${image}`);
      }
    }

    console.log(
      `${chart.name}@${chart.version}: rendered ${images.length} pinned image${images.length === 1 ? "" : "s"}`,
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
