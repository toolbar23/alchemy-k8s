import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  copyFixtureImage,
  deleteFixtureImage,
  inspectFixtureImage,
  kubectl,
  openContext,
  pullFixtureImage,
  recordPhase,
  registryStatus,
  runAlchemy,
  runCommand,
  s3Footprint,
  waitUntil,
} from "./harness.mjs";

const preflightPhase = async (context) => {
  const started = performance.now();
  for (const [command, args] of [
    ["mise", ["exec", "--", "npm", "--version"]],
    [process.env.KUBECTL_BIN ?? "kubectl", ["version", "--client"]],
    ["skopeo", ["--version"]],
    ["curl", ["--version"]],
    ["openssl", ["version"]],
  ]) {
    runCommand(context, command, args);
  }
  runCommand(context, "openssl", [
    "x509",
    "-in",
    context.tlsCertificateFile,
    "-noout",
    "-checkhost",
    context.host,
  ]);
  runCommand(context, "openssl", ["pkey", "-in", context.tlsKeyFile, "-noout"]);
  const ready = kubectl(context, ["get", "--raw=/readyz"]);
  if (ready.stdout.trim() !== "ok") {
    throw new Error("Kubernetes API did not report ready");
  }
  const footprint = await s3Footprint(context);
  runAlchemy(context, "plan");
  recordPhase(context, "preflight", started, { s3: footprint });
};

const deployPhase = async (context) => {
  const started = performance.now();
  runCommand(context, "mise", [
    "exec",
    "--",
    "npm",
    "run",
    "build",
    "--prefix",
    "packages/kubernetes-addons",
  ]);
  const deployed = runAlchemy(context, "deploy");
  kubectl(context, [
    "rollout",
    "status",
    `deployment/${context.releaseName}`,
    "--namespace",
    context.namespace,
    "--timeout=5m",
  ]);
  await waitUntil("authenticated registry readiness", async () =>
    registryStatus(context, context.password) === 200 ? true : false,
  );
  recordPhase(context, "deploy", started, {
    alchemyMs: Math.round(deployed.durationMs),
  });
};

const checksPhase = async (context) => {
  const started = performance.now();
  if (registryStatus(context) !== 401) {
    throw new Error("Registry accepted an unauthenticated /v2/ request");
  }
  if (registryStatus(context, context.password) !== 200) {
    throw new Error("Registry rejected valid basic authentication");
  }

  let emptyFootprint = await s3Footprint(context);
  const retainedFixture = await inspectFixtureImage(context, {
    allowFailure: true,
  });
  if (retainedFixture.status === 0) {
    await deleteFixtureImage(context);
    emptyFootprint = await waitUntil(
      "retained fixture cleanup before checks",
      async () => {
        const footprint = await s3Footprint(context);
        return footprint.bytes < emptyFootprint.bytes ? footprint : false;
      },
      { timeoutMs: 6 * 60_000, intervalMs: 10_000 },
    );
  } else if (
    !/manifest unknown|name unknown|not found|status code: 404/iu.test(
      retainedFixture.stderr,
    )
  ) {
    throw new Error(
      `Could not inspect a possible retained fixture: ${retainedFixture.stderr.trim()}`,
    );
  }
  const pushed = await copyFixtureImage(context);
  const inspected = await inspectFixtureImage(context);
  const imageMetadata = JSON.parse(inspected.stdout);
  if (imageMetadata.Name !== `${context.host}/alchemy/e2e`) {
    throw new Error("Registry returned unexpected fixture image metadata");
  }
  const imageBytes = (imageMetadata.LayersData ?? []).reduce(
    (total, layer) => total + Number(layer.Size ?? 0),
    0,
  );
  const populatedFootprint = await s3Footprint(context);
  if (populatedFootprint.bytes <= emptyFootprint.bytes) {
    throw new Error("Pushing the fixture did not increase the S3 footprint");
  }

  kubectl(context, [
    "delete",
    "pod",
    "--namespace",
    context.applicationNamespace,
    "--selector",
    "app=registry-pull",
  ]);
  kubectl(context, [
    "rollout",
    "status",
    "deployment/registry-pull",
    "--namespace",
    context.applicationNamespace,
    "--timeout=5m",
  ]);
  kubectl(context, [
    "delete",
    "pod",
    "--namespace",
    context.namespace,
    "--selector",
    `app.kubernetes.io/instance=${context.releaseName}`,
  ]);
  kubectl(context, [
    "rollout",
    "status",
    `deployment/${context.releaseName}`,
    "--namespace",
    context.namespace,
    "--timeout=5m",
  ]);
  await inspectFixtureImage(context);

  await deleteFixtureImage(context);
  const collectedFootprint = await waitUntil(
    "Zot garbage collection to reclaim S3 objects",
    async () => {
      const footprint = await s3Footprint(context);
      return footprint.bytes < populatedFootprint.bytes ? footprint : false;
    },
    { timeoutMs: 6 * 60_000, intervalMs: 10_000 },
  );
  const repushed = await copyFixtureImage(context);
  context.benchmarks.initialPush = {
    durationMs: Math.round(repushed.durationMs),
    imageBytes,
    mebibytesPerSecond:
      imageBytes === 0
        ? undefined
        : Number(
            (imageBytes / 1024 / 1024 / (repushed.durationMs / 1000)).toFixed(
              2,
            ),
          ),
  };
  recordPhase(context, "checks", started, {
    pushMs: Math.round(pushed.durationMs),
    s3: {
      beforePush: emptyFootprint,
      afterPush: populatedFootprint,
      afterGc: collectedFootprint,
    },
  });
};

const benchmarkPhase = async (context) => {
  const started = performance.now();
  const inspected = await inspectFixtureImage(context);
  const imageMetadata = JSON.parse(inspected.stdout);
  const imageBytes = (imageMetadata.LayersData ?? []).reduce(
    (total, layer) => total + Number(layer.Size ?? 0),
    0,
  );
  const pull = await pullFixtureImage(context);
  const podUsage = kubectl(
    context,
    [
      "top",
      "pod",
      "--namespace",
      context.namespace,
      "--selector",
      `app.kubernetes.io/instance=${context.releaseName}`,
      "--no-headers",
    ],
    { allowFailure: true },
  );
  context.benchmarks = {
    ...context.benchmarks,
    pull: {
      durationMs: Math.round(pull.durationMs),
      imageBytes,
      mebibytesPerSecond:
        imageBytes === 0
          ? undefined
          : Number(
              (imageBytes / 1024 / 1024 / (pull.durationMs / 1000)).toFixed(2),
            ),
    },
    authenticatedInspectMs: Math.round(inspected.durationMs),
    podUsage:
      podUsage.status === 0 ? podUsage.stdout.trim() : "metrics unavailable",
    s3: await s3Footprint(context),
  };
  recordPhase(context, "benchmark", started);
};

const podUid = (context) =>
  kubectl(context, [
    "get",
    "pod",
    "--namespace",
    context.namespace,
    "--selector",
    `app.kubernetes.io/instance=${context.releaseName}`,
    "--output=jsonpath={.items[0].metadata.uid}",
  ]).stdout.trim();

const idempotencePhase = async (context) => {
  const started = performance.now();
  const initialPod = podUid(context);
  const noChange = runAlchemy(context, "deploy");
  const unchangedPod = podUid(context);
  if (unchangedPod !== initialPod) {
    throw new Error("No-change deploy replaced the registry pod");
  }

  const rotatedPassword = `${context.password}R`;
  runAlchemy(context, "deploy", rotatedPassword);
  await waitUntil("rotated registry credentials", async () =>
    registryStatus(context, rotatedPassword) === 200 ? true : false,
  );
  if (registryStatus(context, context.password) !== 401) {
    throw new Error("Old registry credentials remained valid after rotation");
  }
  const rotatedPod = podUid(context);
  if (rotatedPod === initialPod) {
    throw new Error("Credential rotation did not replace the registry pod");
  }

  runAlchemy(context, "deploy");
  await waitUntil("restored registry credentials", async () =>
    registryStatus(context, context.password) === 200 ? true : false,
  );
  if (podUid(context) === rotatedPod) {
    throw new Error("Credential restoration did not replace the registry pod");
  }
  recordPhase(context, "idempotence-and-rotation", started, {
    noChangeDeployMs: Math.round(noChange.durationMs),
  });
};

const persistencePhase = async (context) => {
  const started = performance.now();
  await inspectFixtureImage(context);
  runAlchemy(context, "destroy");
  runAlchemy(context, "deploy");
  kubectl(context, [
    "rollout",
    "status",
    `deployment/${context.releaseName}`,
    "--namespace",
    context.namespace,
    "--timeout=5m",
  ]);
  await waitUntil("registry recreation", async () =>
    registryStatus(context, context.password) === 200 ? true : false,
  );
  await inspectFixtureImage(context);
  recordPhase(context, "destroy-recreate-persistence", started, {
    retainedS3: await s3Footprint(context),
  });
};

const destroyPhase = async (context) => {
  const started = performance.now();
  runAlchemy(context, "destroy");
  for (const namespace of [context.namespace, context.applicationNamespace]) {
    const result = kubectl(context, ["get", "namespace", namespace], {
      allowFailure: true,
    });
    if (result.status === 0) {
      throw new Error(`Owned namespace remains after destroy: ${namespace}`);
    }
  }
  recordPhase(context, "destroy", started, {
    retainedS3: await s3Footprint(context),
  });
};

const phases = {
  preflight: preflightPhase,
  deploy: deployPhase,
  checks: checksPhase,
  benchmark: benchmarkPhase,
  idempotence: idempotencePhase,
  persistence: persistencePhase,
  destroy: destroyPhase,
};

export const runNamedPhase = async (name) => {
  const context = openContext();
  if (name === "all") {
    await preflightPhase(context);
    await deployPhase(context);
    await checksPhase(context);
    await benchmarkPhase(context);
    await idempotencePhase(context);
    await persistencePhase(context);
    await destroyPhase(context);
    process.stdout.write(`Registry E2E passed: ${context.reportPath}\n`);
    return;
  }
  const phase = phases[name];
  if (phase === undefined) throw new Error(`Unknown registry phase: ${name}`);
  await phase(context);
  process.stdout.write(`${name} passed: ${context.reportPath}\n`);
};
