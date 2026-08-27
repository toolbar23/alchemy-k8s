import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stackFile = join(
  root,
  "scripts",
  "kubernetes-api-e2e",
  "alchemy.run.mjs",
);

const run = (
  command,
  args,
  { env = {}, input, allowFailure = false, timeout = 20 * 60_000 } = {},
) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()}`,
    );
  }
  return result;
};

const kubectl = (kubeconfig, args, options) =>
  run(
    process.env.KUBECTL_BIN ?? "kubectl",
    ["--kubeconfig", kubeconfig, ...args],
    options,
  );

const alchemy = (
  kubeconfig,
  stage,
  action,
  serviceName,
  { allowFailure = false } = {},
) =>
  run(
    process.env.ALCHEMY_BIN ?? join(root, "node_modules", ".bin", "alchemy"),
    [
      action,
      "--stage",
      stage,
      ...(action === "plan" ? [] : ["--yes"]),
      stackFile,
    ],
    {
      env: {
        KUBERNETES_API_E2E_KUBECONFIG: kubeconfig,
        KUBERNETES_API_E2E_STAGE: stage,
        KUBERNETES_API_E2E_SERVICE: serviceName,
      },
      allowFailure,
    },
  );

export const runLifecycle = ({ kubeconfig, stage, version }) => {
  const namespace = `typed-api-${stage}`;
  const group = `${stage}.alchemy.run`;
  const report = {
    stage,
    version,
    checks: [],
    startedAt: new Date().toISOString(),
  };
  let primaryError;
  try {
    kubectl(kubeconfig, ["apply", "-f", "-"], {
      input: `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: ${namespace}
data:
  value: foreign
`,
    });
    alchemy(kubeconfig, stage, "deploy", "database-v1");
    const adopted = JSON.parse(
      kubectl(kubeconfig, [
        "get",
        "configmap",
        "settings",
        "-n",
        namespace,
        "-o",
        "json",
      ]).stdout,
    );
    if (
      adopted.data?.value !== "desired" ||
      adopted.metadata?.annotations?.["alchemy.run/fqn"] === undefined
    ) {
      throw new Error("adoption did not converge data and ownership");
    }
    report.checks.push("adoption");

    const second = alchemy(kubeconfig, stage, "plan", "database-v1");
    if (
      !/Plan:\s*\d+ to noop/i.test(second.stdout) ||
      /\bto (?:create|update|replace|delete)\b/i.test(second.stdout)
    ) {
      throw new Error(`second plan was not a no-op: ${second.stdout}`);
    }
    report.checks.push("noop");

    const beforeDrift = JSON.parse(
      kubectl(kubeconfig, [
        "get",
        "configmap",
        "settings",
        "-n",
        namespace,
        "-o",
        "json",
      ]).stdout,
    );
    kubectl(
      kubeconfig,
      [
        "apply",
        "--server-side=true",
        "--force-conflicts",
        "--field-manager=typed-api-e2e",
        "-f",
        "-",
      ],
      {
        input: JSON.stringify({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: {
            name: "settings",
            namespace,
            annotations: beforeDrift.metadata.annotations,
          },
          data: { value: "drifted" },
        }),
      },
    );
    alchemy(kubeconfig, stage, "deploy", "database-v1");
    const repaired = kubectl(kubeconfig, [
      "get",
      "configmap",
      "settings",
      "-n",
      namespace,
      "-o",
      "jsonpath={.data.value}",
    ]).stdout;
    if (repaired !== "desired") throw new Error("drift was not repaired");
    report.checks.push("drift");

    alchemy(kubeconfig, stage, "deploy", "database-v2");
    const serviceName = kubectl(kubeconfig, [
      "get",
      "statefulset",
      "database",
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.serviceName}",
    ]).stdout;
    if (serviceName !== "database-v2") {
      throw new Error("immutable StatefulSet replacement did not converge");
    }
    report.checks.push("immutable-replacement");

    const widget = kubectl(kubeconfig, [
      "get",
      "widget",
      "example",
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.size}",
    ]).stdout;
    if (widget !== "3") throw new Error("generic CRD object was not applied");
    report.checks.push("generic-crd");

    alchemy(kubeconfig, stage, "destroy", "database-v2");
    const namespaceRead = kubectl(kubeconfig, ["get", "namespace", namespace], {
      allowFailure: true,
    });
    if (namespaceRead.status === 0)
      throw new Error("destroy retained namespace");
    report.checks.push("destroy");
  } catch (error) {
    primaryError = error;
  } finally {
    alchemy(kubeconfig, stage, "destroy", "database-v2", {
      allowFailure: true,
    });
    kubectl(
      kubeconfig,
      ["delete", "namespace", namespace, "--ignore-not-found=true"],
      { allowFailure: true },
    );
    kubectl(
      kubeconfig,
      [
        "delete",
        "customresourcedefinition",
        `widgets.${group}`,
        "--ignore-not-found=true",
      ],
      { allowFailure: true },
    );
  }
  report.finishedAt = new Date().toISOString();
  const reportPath = join(
    root,
    "test-results",
    "kubernetes-api",
    `${stage}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (primaryError !== undefined) throw primaryError;
  return report;
};
