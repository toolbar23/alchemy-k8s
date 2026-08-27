import { spawnSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { runLifecycle } from "./harness.mjs";

const { AbortSignal, fetch } = globalThis;
const k3d = process.env.K3D_BIN ?? "k3d";
const channels = (process.env.KUBERNETES_API_E2E_CHANNELS ?? "v1.36,v1.35")
  .split(",")
  .map((channel) => channel.trim());
const run = (args, { allowFailure = false } = {}) => {
  const result = spawnSync(k3d, args, {
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${k3d} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
};
const resolveChannel = async (channel) => {
  const response = await fetch(
    `https://update.k3s.io/v1-release/channels/${channel}`,
    { redirect: "manual", signal: AbortSignal.timeout(15_000) },
  );
  const location = response.headers.get("location");
  const match = /v\d+\.\d+\.\d+(?:\+k3s\d+)?/.exec(
    decodeURIComponent(location ?? ""),
  );
  if (match === null) {
    throw new Error(`K3s channel ${channel} returned no release redirect`);
  }
  return match[0];
};

const directory = mkdtempSync(join(tmpdir(), "alchemy-kubernetes-native-e2e-"));
const reports = [];
try {
  const existing = JSON.parse(run(["cluster", "list", "-o", "json"]).stdout);
  for (const channel of channels) {
    if (!/^v1\.\d+$/.test(channel)) {
      throw new Error(`Invalid pinned K3s minor channel: ${channel}`);
    }
    const suffix = channel.replace("v1.", "");
    const name = `alchemy-typed-api-${suffix}`;
    if (existing.some((cluster) => cluster.name === name)) {
      throw new Error(`Refusing to reuse existing k3d cluster ${name}`);
    }
    const version = await resolveChannel(channel);
    try {
      run([
        "cluster",
        "create",
        name,
        "--servers",
        "1",
        "--agents",
        "0",
        "--image",
        `rancher/k3s:${version.replace("+", "-")}`,
        "--kubeconfig-update-default=false",
        "--kubeconfig-switch-context=false",
        "--wait",
        "--timeout",
        "10m",
      ]);
      const kubeconfig = join(directory, `${name}.yaml`);
      writeFileSync(kubeconfig, run(["kubeconfig", "get", name]).stdout, {
        mode: 0o600,
      });
      reports.push(
        runLifecycle({
          kubeconfig,
          stage: `k3s-${suffix}-${String(process.pid)}`,
          version,
        }),
      );
    } finally {
      run(["cluster", "delete", name], { allowFailure: true });
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(JSON.stringify(reports, null, 2));
