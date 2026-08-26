import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import process from "node:process";
import {
  assertKubeconfig,
  confirmProfile,
  hcloud,
  inventoryIds,
  kubectl,
  openContext,
  readInventory,
  recordBenchmark,
  recordCheck,
  recordPhase,
  runAlchemy,
  saveLedger,
  waitUntil,
} from "./harness.mjs";
import { baselineDesired } from "./profiles.mjs";

const { AbortSignal, fetch } = globalThis;

const context = await openContext(process.argv.slice(2));
if (!new Set(["small-x86", "ha-x86"]).has(context.profile)) {
  throw new Error("Disaster recovery E2E supports small-x86 and ha-x86");
}
for (const name of [
  "HETZNER_E2E_STATE_DATABASE_URL",
  "HETZNER_E2E_S3_ENDPOINT",
  "HETZNER_E2E_S3_REGION",
  "HETZNER_E2E_S3_BUCKET",
  "HETZNER_E2E_S3_ACCESS_KEY_ID",
  "HETZNER_E2E_S3_SECRET_ACCESS_KEY",
]) {
  if (!process.env[name]?.trim()) throw new Error(`Set ${name}`);
}
if (process.env.HETZNER_E2E_STATE_ENCRYPTED !== "true") {
  throw new Error(
    "Set HETZNER_E2E_STATE_ENCRYPTED=true after verifying TLS and provider-side database encryption",
  );
}

const desired = {
  ...baselineDesired(context.profile),
  etcdSnapshots: {
    schedule: "*/2 * * * *",
    retention: 12,
    folder: `alchemy-k3s-e2e/${context.runId}`,
  },
  recovery: {
    restoreOnInitialControlPlaneReplacement: true,
    maximumSnapshotAge: 15 * 60,
  },
};
if (
  context.ledger !== undefined &&
  context.ledger.desired?.recovery === undefined
) {
  throw new Error(
    "The existing suite ledger uses local state; start recovery E2E with a fresh profile ledger",
  );
}
await confirmProfile(
  context,
  `Create, physically delete, restore, verify, and destroy ${context.profile}. The retained S3 prefix is ${desired.etcdSnapshots.folder}.`,
);
await saveLedger(context, { desired, phase: "recovery-creating" });

const totalStarted = performance.now();
await runAlchemy(context, "deploy", desired, "recovery-create");
await assertKubeconfig(context);
const initialInventory = await readInventory(context);
await saveLedger(context, {
  desired,
  phase: "recovery-created",
  resources: inventoryIds(initialInventory),
});

const namespace = `hke2e-dr-${context.runId}`
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-")
  .slice(-63)
  .replace(/^-|-$/g, "");
const marker = randomUUID();
await kubectl(context, ["apply", "-f", "-"], {
  input: `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
---
apiVersion: v1
kind: Secret
metadata:
  name: recovery-marker
  namespace: ${namespace}
type: Opaque
stringData:
  value: ${marker}
`,
  logName: "recovery-fixture",
});
const fixtureAppliedAt = Date.now();

const snapshot = await waitUntil(
  "a successful remote etcd snapshot containing the recovery marker",
  async () => {
    const result = await kubectl(
      context,
      ["get", "etcdsnapshotfiles.k3s.cattle.io", "-o", "json"],
      { allowFailure: true, quiet: true, logName: "recovery-snapshot" },
    );
    if (result.code !== 0) return false;
    const candidates = JSON.parse(result.stdout)
      .items.filter(
        (item) =>
          item.spec?.location?.startsWith(
            `s3://${process.env.HETZNER_E2E_S3_BUCKET}/${desired.etcdSnapshots.folder}/`,
          ) &&
          item.status?.readyToUse === true &&
          Date.parse(item.status.creationTime) >= fixtureAppliedAt,
      )
      .sort(
        (left, right) =>
          Date.parse(right.status.creationTime) -
          Date.parse(left.status.creationTime),
      );
    return candidates[0] ?? false;
  },
  { timeoutMs: 6 * 60_000, intervalMs: 15_000 },
);
const snapshotCreatedAt = Date.parse(snapshot.status.creationTime);

const initialControlPlane = initialInventory.servers.find(
  (server) =>
    server.labels["k3s.role"] === "server" &&
    server.name.endsWith("control-plane-1"),
);
if (initialControlPlane === undefined) {
  throw new Error("Unable to identify initial control-plane server");
}
const failureStarted = performance.now();
const protection = await hcloud(
  context,
  `/servers/${initialControlPlane.id}/actions/change_protection`,
  {
    method: "POST",
    body: JSON.stringify({ delete: false, rebuild: false }),
  },
);
await waitUntil(
  "initial control-plane protection removal",
  async () =>
    (await hcloud(context, `/actions/${protection.action.id}`)).action
      .status === "success",
  { timeoutMs: 2 * 60_000, intervalMs: 2_000 },
);
await hcloud(context, `/servers/${initialControlPlane.id}`, {
  method: "DELETE",
});
await waitUntil(
  "physical initial-control-plane deletion",
  async () => {
    const response = await fetch(
      `https://api.hetzner.cloud/v1/servers/${initialControlPlane.id}`,
      {
        headers: { Authorization: `Bearer ${context.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    return response.status === 404;
  },
  { timeoutMs: 5 * 60_000, intervalMs: 5_000 },
);
const detectedAt = performance.now();

await saveLedger(context, { phase: "recovery-restoring" });
const restore = await runAlchemy(
  context,
  "deploy",
  desired,
  "recovery-restore",
);
const apiRecoveredAt = performance.now();
await assertKubeconfig(context);
const recoveredValue = await kubectl(
  context,
  [
    "get",
    "secret/recovery-marker",
    "--namespace",
    namespace,
    "-o",
    "jsonpath={.data.value}",
  ],
  { quiet: true, logName: "recovery-verify" },
);
if (Buffer.from(recoveredValue.stdout.trim(), "base64").toString() !== marker) {
  throw new Error(
    "Recovered Kubernetes Secret does not match pre-failure data",
  );
}
await kubectl(
  context,
  ["wait", "nodes", "--all", "--for=condition=Ready", "--timeout=15m"],
  { quiet: true, logName: "recovery-verify", timeoutMs: 16 * 60_000 },
);
const workersReconnectedAt = performance.now();
const recoveredInventory = await readInventory(context);
if (
  recoveredInventory.servers.some(({ id }) => id === initialControlPlane.id) ||
  !recoveredInventory.servers.some(
    ({ labels, id }) =>
      labels["k3s.role"] === "server" && id !== initialControlPlane.id,
  )
) {
  throw new Error(
    "Hetzner inventory does not contain the replacement control plane",
  );
}

const metrics = {
  snapshotAgeMs: performance.timeOrigin + failureStarted - snapshotCreatedAt,
  detectionDelayMs: detectedAt - failureStarted,
  replacementAndRestoreMs: restore.durationMs,
  apiRecoveryMs: apiRecoveredAt - failureStarted,
  workerReconnectionMs: workersReconnectedAt - apiRecoveredAt,
  totalRtoMs: workersReconnectedAt - failureStarted,
  observableRpoMs: 0,
  originalServerId: initialControlPlane.id,
  recoveredServerIds: recoveredInventory.servers.map(({ id }) => id),
  snapshot: snapshot.spec.snapshotName,
};
await recordBenchmark(context, "disasterRecovery", metrics);
await recordCheck(context, "disasterRecovery", {
  markerRecovered: true,
  allNodesReady: true,
  ...metrics,
});
await recordPhase(
  context,
  "disaster-recovery",
  "passed",
  performance.now() - totalStarted,
);

const unprotected = { ...desired, protected: false };
await runAlchemy(context, "deploy", unprotected, "recovery-disable-protection");
await runAlchemy(context, "destroy", unprotected, "recovery-destroy");
await saveLedger(context, {
  desired: unprotected,
  phase: "recovery-destroyed",
  resources: {},
});
process.stdout.write(
  `Disaster recovery passed and cluster resources were destroyed. Retained backup prefix: s3://${process.env.HETZNER_E2E_S3_BUCKET}/${desired.etcdSnapshots.folder}/\n`,
);
