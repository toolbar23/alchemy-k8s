import type {
  NodeReference,
  SecretsEncryptionFailurePoint,
  ServerReference,
} from "./types.ts";
import { k3sVersion, ssh, sshScript } from "./remote.ts";

export interface SecretsEncryptionStatus {
  enabled: boolean;
  noConfiguration: boolean;
  stage: string | undefined;
  hashesMatch: boolean | undefined;
  provider: "secretbox" | "aescbc" | undefined;
}

const versionParts = (version: string): { minor: number; patch: number } => {
  const match = /^v1\.(\d+)\.(\d+)(?:\+|-)k3s\d+$/.exec(version.trim());
  if (match === null) {
    throw new Error(`Unsupported K3s version format: ${version}`);
  }
  return { minor: Number(match[1]), patch: Number(match[2]) };
};

/** Secretbox became available in the April 2025 patch releases. */
export const supportsSecretbox = (version: string): boolean => {
  const { minor, patch } = versionParts(version);
  if (minor >= 33) return true;
  const minimumPatch = new Map([
    [30, 12],
    [31, 8],
    [32, 4],
  ]).get(minor);
  return minimumPatch !== undefined && patch >= minimumPatch;
};

/** Enabling encryption on an already-running cluster was gated in March 2026. */
export const supportsExistingClusterMigration = (version: string): boolean => {
  const { minor, patch } = versionParts(version);
  if (minor >= 36) return true;
  const minimumPatch = new Map([
    [33, 10],
    [34, 6],
    [35, 3],
  ]).get(minor);
  return minimumPatch !== undefined && patch >= minimumPatch;
};

export const secretsEncryptionArguments = (version: string): string[] => [
  "--secrets-encryption",
  ...(supportsSecretbox(version)
    ? ["--secrets-encryption-provider", "secretbox"]
    : []),
];

export const parseSecretsEncryptionStatus = (
  output: string,
): SecretsEncryptionStatus => {
  const status = /Encryption Status:\s*(Enabled|Disabled)([^\n]*)/i.exec(
    output,
  );
  if (status === null) {
    throw new Error("K3s returned an unrecognized secrets-encrypt status");
  }
  const stage = /Current Rotation Stage:\s*([^\s]+)/i.exec(output)?.[1];
  const hashes = /Server Encryption Hashes:\s*([^\n]+)/i.exec(output)?.[1];
  const activeKey = /^\s*\*\s+(.+)$/m.exec(output)?.[1]?.toLowerCase();
  return {
    enabled: status[1]?.toLowerCase() === "enabled",
    noConfiguration: /no configuration file found/i.test(status[2] ?? ""),
    stage,
    hashesMatch:
      hashes === undefined ? undefined : /all hashes match/i.test(hashes),
    provider:
      activeKey === undefined
        ? undefined
        : activeKey.includes("secretbox") ||
            activeKey.includes("xsalsa20-poly1305")
          ? "secretbox"
          : activeKey.includes("aes-cbc") || activeKey.includes("aescbc")
            ? "aescbc"
            : undefined,
  };
};

export const inspectSecretsEncryption = async (
  server: ServerReference,
): Promise<SecretsEncryptionStatus> =>
  parseSecretsEncryptionStatus(
    await ssh(server, "k3s secrets-encrypt status", 60_000),
  );

const migrationMarker =
  "/var/lib/rancher/k3s/server/db/.alchemy-secrets-encryption-migration";

export const buildPrepareSecretsEncryptionScript = (
  failureInjection: SecretsEncryptionFailurePoint | undefined,
  mode: "enable" | "provider" = "enable",
): string => `set -euo pipefail
marker=${JSON.stringify(migrationMarker)}
mkdir -p "$(dirname "$marker")"
if [ ! -f "$marker" ]; then
  snapshot="alchemy-pre-secrets-encryption-$(date -u +%Y%m%dT%H%M%SZ)"
  k3s etcd-snapshot save --name "$snapshot"
  k3s etcd-snapshot ls | grep -F -- "$snapshot" >/dev/null
  snapshot_file=$(find /var/lib/rancher/k3s/server/db/snapshots -maxdepth 1 -type f -name "$snapshot*" -size +0c -print -quit)
  if [ -z "$snapshot_file" ]; then
    echo "K3s did not create a non-empty pre-migration etcd snapshot" >&2
    exit 1
  fi
  printf 'snapshot=%s\nphase=snapshot_verified\nmode=%s\n' "$snapshot" ${JSON.stringify(mode)} > "${migrationMarker}.tmp"
  mv "${migrationMarker}.tmp" "$marker"
fi
snapshot=$(sed -n 's/^snapshot=//p' "$marker")
recorded_mode=$(sed -n 's/^mode=//p' "$marker")
recorded_mode=${"${recorded_mode:-enable}"}
if [ "$recorded_mode" != ${JSON.stringify(mode)} ]; then
  echo "The recorded migration mode does not match the requested migration" >&2
  exit 1
fi
if [ -z "$snapshot" ] || ! k3s etcd-snapshot ls | grep -F -- "$snapshot" >/dev/null; then
  echo "The recorded pre-migration etcd snapshot cannot be verified" >&2
  exit 1
fi
snapshot_file=$(find /var/lib/rancher/k3s/server/db/snapshots -maxdepth 1 -type f -name "$snapshot*" -size +0c -print -quit)
if [ -z "$snapshot_file" ]; then
  echo "The recorded pre-migration etcd snapshot is empty or missing" >&2
  exit 1
fi
${failureInjection === "after-snapshot" ? 'echo "Injected secrets-encryption migration failure after snapshot verification" >&2\nexit 97' : ""}
status=$(k3s secrets-encrypt status)
if [ "$recorded_mode" = enable ] && printf '%s\n' "$status" | grep -q 'Encryption Status: Disabled, no configuration file found'; then
  k3s secrets-encrypt enable
fi
printf 'snapshot=%s\nphase=prepared\nmode=%s\n' "$snapshot" "$recorded_mode" > "${migrationMarker}.tmp"
mv "${migrationMarker}.tmp" "$marker"
${failureInjection === "after-enable" ? 'echo "Injected secrets-encryption migration failure after enablement" >&2\nexit 97' : ""}
`;

export const prepareExistingClusterEncryption = async (
  server: ServerReference,
  installedVersion: string,
  desiredVersion: string,
  migrateExisting: boolean,
  failureInjection: SecretsEncryptionFailurePoint | undefined,
): Promise<void> => {
  const status = await inspectSecretsEncryption(server);
  if (status.enabled && status.provider === "secretbox") return;
  if (status.enabled && !supportsSecretbox(desiredVersion)) return;
  if (status.enabled && status.provider !== "aescbc") {
    throw new Error(
      "This existing cluster uses an unknown Secret encryption provider; refusing to change its K3s arguments",
    );
  }
  if (!migrateExisting) {
    throw new Error(
      status.enabled
        ? "This existing cluster uses aescbc. Set secretsEncryption.migrateExisting to true to run the guarded migration to secretbox."
        : "This existing cluster is not encrypted. Set secretsEncryption.migrateExisting to true to run the guarded snapshot-and-restart migration.",
    );
  }
  if (
    !supportsExistingClusterMigration(
      status.enabled ? desiredVersion : installedVersion,
    )
  ) {
    throw new Error(
      `K3s ${status.enabled ? desiredVersion : installedVersion} cannot safely migrate Secret encryption on an existing cluster; upgrade first to v1.33.10+k3s1, v1.34.6+k3s1, v1.35.3+k3s1, or newer`,
    );
  }
  await sshScript(
    server,
    buildPrepareSecretsEncryptionScript(
      failureInjection,
      status.enabled ? "provider" : "enable",
    ),
    15 * 60_000,
  );
};

interface MigrationMarker {
  snapshot: string;
  phase: string;
  mode: "enable" | "provider";
}

const readMigrationMarker = async (
  server: ServerReference,
): Promise<MigrationMarker | undefined> => {
  const output = await ssh(
    server,
    `test ! -f ${JSON.stringify(migrationMarker)} || cat ${JSON.stringify(migrationMarker)}`,
  );
  if (output.trim().length === 0) return undefined;
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
  if (!values.snapshot || !values.phase) {
    throw new Error("The K3s Secret encryption migration marker is invalid");
  }
  if (
    values.mode !== undefined &&
    values.mode !== "enable" &&
    values.mode !== "provider"
  ) {
    throw new Error("The K3s Secret encryption migration mode is invalid");
  }
  return {
    snapshot: values.snapshot,
    phase: values.phase === "enabled" ? "prepared" : values.phase,
    mode: values.mode ?? "enable",
  };
};

const writeMigrationPhase = async (
  server: ServerReference,
  snapshot: string,
  phase: string,
  mode: "enable" | "provider",
): Promise<void> => {
  const script = `set -euo pipefail
printf 'snapshot=%s\nphase=%s\nmode=%s\n' ${JSON.stringify(snapshot)} ${JSON.stringify(phase)} ${JSON.stringify(mode)} > ${JSON.stringify(`${migrationMarker}.tmp`)}
mv ${JSON.stringify(`${migrationMarker}.tmp`)} ${JSON.stringify(migrationMarker)}
`;
  await sshScript(server, script);
};

const inspectControlPlanes = async (
  controlPlanes: NodeReference[],
): Promise<Array<{ node: NodeReference; status: SecretsEncryptionStatus }>> => {
  const statuses = [];
  for (const node of controlPlanes) {
    statuses.push({
      node,
      status: await inspectSecretsEncryption(node.server),
    });
  }
  return statuses;
};

const assertMatchingHashes = (
  statuses: Array<{ node: NodeReference; status: SecretsEncryptionStatus }>,
): void => {
  const mismatched = statuses
    .filter(({ status }) => status.hashesMatch !== true)
    .map(({ node }) => node.name);
  if (mismatched.length > 0) {
    throw new Error(
      `K3s Secret encryption hashes do not match on control plane(s): ${mismatched.join(", ")}; refusing to advance the migration`,
    );
  }
};

const assertMigrationStart = (
  statuses: Array<{ node: NodeReference; status: SecretsEncryptionStatus }>,
): void => {
  const invalid = statuses
    .filter(({ status }) => status.enabled || status.stage !== "start")
    .map(
      ({ node, status }) =>
        `${node.name} (${status.enabled ? "enabled" : "disabled"}, ${status.stage ?? "no stage"})`,
    );
  if (invalid.length > 0) {
    throw new Error(
      `K3s Secret encryption migration is not at the expected disabled/start stage: ${invalid.join(", ")}`,
    );
  }
  assertMatchingHashes(statuses);
};

const assertProviderMigrationStart = (
  statuses: Array<{ node: NodeReference; status: SecretsEncryptionStatus }>,
): void => {
  const invalid = statuses
    .filter(
      ({ status }) =>
        !status.enabled ||
        status.provider !== "aescbc" ||
        !["start", "reencrypt_finished"].includes(status.stage ?? ""),
    )
    .map(
      ({ node, status }) =>
        `${node.name} (${status.enabled ? "enabled" : "disabled"}, ${status.provider ?? "unknown provider"}, ${status.stage ?? "no stage"})`,
    );
  if (invalid.length > 0) {
    throw new Error(
      `K3s Secret encryption provider migration is not at a stable aescbc stage: ${invalid.join(", ")}`,
    );
  }
  assertMatchingHashes(statuses);
};

const assertFinalEncryption = (
  statuses: Array<{ node: NodeReference; status: SecretsEncryptionStatus }>,
  requireFinished: boolean,
): void => {
  const invalid = statuses
    .filter(
      ({ node, status }) =>
        !status.enabled ||
        status.provider !==
          (supportsSecretbox(node.version) ? "secretbox" : "aescbc") ||
        (requireFinished && status.stage !== "reencrypt_finished"),
    )
    .map(
      ({ node, status }) =>
        `${node.name} (${status.enabled ? "enabled" : "disabled"}, ${status.provider ?? "unknown provider"}, ${status.stage ?? "no stage"})`,
    );
  if (invalid.length > 0) {
    throw new Error(
      `K3s Secret encryption verification failed: ${invalid.join(", ")}`,
    );
  }
  assertMatchingHashes(statuses);
};

const injectFailure = (
  selected: SecretsEncryptionFailurePoint | undefined,
  point: SecretsEncryptionFailurePoint,
): void => {
  if (selected === point) {
    throw new Error(`Injected secrets-encryption migration failure ${point}`);
  }
};

const waitForReencryption = async (server: ServerReference): Promise<void> => {
  const deadline = Date.now() + 30 * 60_000;
  let last = "unknown";
  while (Date.now() < deadline) {
    const status = await inspectSecretsEncryption(server);
    last = `${status.enabled ? "enabled" : "disabled"}/${status.stage ?? "no-stage"}`;
    if (status.enabled && status.stage === "reencrypt_finished") return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Timed out waiting for K3s Secret re-encryption; last status: ${last}`,
  );
};

const restartControlPlanes = async (
  controlPlanes: NodeReference[],
): Promise<void> => {
  const initial = controlPlanes[0];
  if (initial === undefined) throw new Error("Cluster has no control plane");
  for (const node of controlPlanes) {
    await sshScript(
      node.server,
      `set -euo pipefail
systemctl restart k3s
for attempt in $(seq 1 120); do
  k3s kubectl get --raw=/readyz >/dev/null 2>&1 && exit 0
  sleep 5
done
echo "K3s did not become ready after restart" >&2
exit 1
`,
      11 * 60_000,
    );
    await ssh(
      initial.server,
      `k3s kubectl wait --for=condition=Ready node/${JSON.stringify(node.name)} --timeout=10m`,
      11 * 60_000,
    );
  }
};

export interface EncryptionSummary {
  enabled: boolean;
  provider: "secretbox" | "aescbc" | undefined;
  stage: string | undefined;
  hashesMatch: boolean;
}

export const inspectClusterEncryption = async (
  controlPlanes: NodeReference[],
): Promise<EncryptionSummary> => {
  const statuses = await inspectControlPlanes(controlPlanes);
  return {
    enabled: statuses.every(({ status }) => status.enabled),
    provider: statuses[0]?.status.provider,
    stage:
      new Set(statuses.map(({ status }) => status.stage)).size === 1
        ? statuses[0]?.status.stage
        : "mixed",
    hashesMatch: statuses.every(({ status }) => status.hashesMatch === true),
  };
};

/** K3s v1.35+ rotates and re-encrypts dynamically without manual restarts. */
export const rotateSecretsEncryptionKeys = async (
  controlPlanes: NodeReference[],
): Promise<void> => {
  const first = controlPlanes[0];
  if (first === undefined) throw new Error("Cluster has no control-plane node");
  for (const node of controlPlanes) {
    const version = await k3sVersion(node.server);
    const parsed =
      version === undefined ? undefined : /^v?1\.(\d+)\./.exec(version);
    if (parsed === undefined || parsed === null || Number(parsed[1]) < 35) {
      throw new Error(
        `Dynamic Secret-encryption key rotation requires K3s v1.35+ on ${node.name}`,
      );
    }
  }
  await ssh(first.server, "k3s secrets-encrypt rotate-keys", 5 * 60_000);
  const statuses = await Promise.all(
    controlPlanes.map(async (node) => ({
      node,
      status: await inspectSecretsEncryption(node.server),
    })),
  );
  const unhealthy = statuses.filter(
    ({ status }) =>
      !status.enabled || status.provider !== "secretbox" || !status.hashesMatch,
  );
  if (unhealthy.length > 0) {
    throw new Error(
      `Secret-encryption key rotation did not converge on: ${unhealthy.map(({ node }) => node.name).join(", ")}`,
    );
  }
};

export const ensureSecretsEncryption = async (
  controlPlanes: NodeReference[],
  failureInjection: SecretsEncryptionFailurePoint | undefined,
): Promise<void> => {
  const initial = controlPlanes[0];
  if (initial === undefined) throw new Error("Cluster has no control plane");
  const marker = await readMigrationMarker(initial.server);
  let statuses = await inspectControlPlanes(controlPlanes);

  if (marker === undefined) {
    assertFinalEncryption(statuses, false);
    return;
  }

  let phase = marker.phase;
  if (phase === "snapshot_verified" || phase === "prepared") {
    if (marker.mode === "enable") assertMigrationStart(statuses);
    else assertProviderMigrationStart(statuses);
    phase = "control_planes_restarted";
    await writeMigrationPhase(
      initial.server,
      marker.snapshot,
      phase,
      marker.mode,
    );
    injectFailure(failureInjection, "after-control-plane-restarts");
  }

  if (phase === "control_planes_restarted") {
    statuses = await inspectControlPlanes(controlPlanes);
    const initialStatus = statuses[0]?.status;
    const expectedProvider = supportsSecretbox(initial.version)
      ? "secretbox"
      : "aescbc";
    if (
      initialStatus?.stage === "reencrypt_request" ||
      initialStatus?.stage === "reencrypt_active" ||
      (initialStatus?.stage === "reencrypt_finished" &&
        initialStatus.provider === expectedProvider)
    ) {
      await waitForReencryption(initial.server);
    } else {
      if (marker.mode === "enable") assertMigrationStart(statuses);
      else assertProviderMigrationStart(statuses);
      await ssh(initial.server, "k3s secrets-encrypt rotate-keys", 30 * 60_000);
      await waitForReencryption(initial.server);
    }
    phase = "rotated";
    await writeMigrationPhase(
      initial.server,
      marker.snapshot,
      phase,
      marker.mode,
    );
    injectFailure(failureInjection, "after-rotate");
  }

  if (phase === "rotated") {
    await waitForReencryption(initial.server);
    await restartControlPlanes(controlPlanes);
    phase = "control_planes_finalized";
    await writeMigrationPhase(
      initial.server,
      marker.snapshot,
      phase,
      marker.mode,
    );
    injectFailure(failureInjection, "after-final-restarts");
  }

  if (phase === "control_planes_finalized" || phase === "complete") {
    statuses = await inspectControlPlanes(controlPlanes);
    assertFinalEncryption(statuses, true);
    if (phase !== "complete") {
      await writeMigrationPhase(
        initial.server,
        marker.snapshot,
        "complete",
        marker.mode,
      );
    }
    return;
  }

  throw new Error(`Unknown K3s Secret encryption migration phase: ${phase}`);
};
