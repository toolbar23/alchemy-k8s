import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  inspectCloudflare,
  inspectKairos,
  SMOKE_HOST,
  validatePublicHosts,
} from "./preflight.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}/.env`)) loadEnvFile(`${root}/.env`);
const command = process.argv[2] ?? "preflight";
if (
  !["preflight", "plan", "deploy", "verify", "cleanup"].includes(command) ||
  process.argv.slice(3).some((arg) => arg !== "--smoke")
)
  throw new Error(
    "Usage: node examples/kairos-platform/run.mjs preflight|plan|deploy|verify|cleanup [--smoke]",
  );
const hosts = validatePublicHosts(
  (process.env.KAIROS_PUBLIC_HOSTS ?? SMOKE_HOST)
    .split(",")
    .map((host) => host.trim()),
);
const kubeArgs = inspectKairos(hosts);
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const cloudflare = await inspectCloudflare(account, token, hosts);
if (command === "preflight") {
  process.stdout.write(
    "Kairos context, IP, DNS ownership, and Cloudflare Access preflight passed. Write permissions and encrypted state are checked by Alchemy plan/deploy.\n",
  );
} else if (["plan", "deploy", "cleanup"].includes(command)) {
  execFileSync(
    process.execPath,
    [
      "node_modules/alchemy/bin/cli.js",
      command === "cleanup" ? "deploy" : command,
      "examples/kairos-platform/alchemy.run.ts",
      "--stage",
      "kairos",
      ...(command === "plan" ? [] : ["--yes"]),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        KAIROS_SMOKE_TEST:
          command !== "cleanup" && process.argv.includes("--smoke")
            ? "true"
            : "false",
      },
    },
  );
  if (command === "cleanup") {
    for (let attempt = 0; attempt < 30; attempt++) {
      let remaining = 0;
      for (const name of [SMOKE_HOST, `_ctic_managed.${SMOKE_HOST}`]) {
        const response = await globalThis.fetch(
          `https://api.cloudflare.com/client/v4/zones/${cloudflare.zoneId}/dns_records?name=${name}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: globalThis.AbortSignal.timeout(10_000),
          },
        );
        const body = await response.json();
        if (!response.ok || !body.success)
          throw new Error("Could not verify smoke DNS cleanup");
        remaining += body.result.length;
      }
      if (remaining === 0) {
        process.stdout.write(
          "Smoke route removed and DNS cleanup confirmed.\n",
        );
        break;
      }
      if (attempt === 29)
        throw new Error(
          "Smoke DNS did not disappear within 150 seconds; retain the controller until cleanup completes",
        );
      await delay(5000);
    }
  }
} else {
  if (!cloudflare.tunnelId) throw new Error("Kairos tunnel does not exist");
  execFileSync(
    "kubectl",
    [
      ...kubeArgs,
      "-n",
      "cloudflare-tunnel-system",
      "rollout",
      "status",
      "deployment/cloudflare-tunnel",
      "--timeout=300s",
    ],
    { stdio: "inherit" },
  );
  const deployments = JSON.parse(
    execFileSync(
      "kubectl",
      [
        ...kubeArgs,
        "-n",
        "cloudflare-tunnel-system",
        "get",
        "deployments",
        "-o",
        "json",
      ],
      { encoding: "utf8" },
    ),
  );
  const connectors = deployments.items.filter((item) =>
    item.metadata.ownerReferences?.some(
      (owner) =>
        owner.kind === "Deployment" && owner.name === "cloudflare-tunnel",
    ),
  );
  if (connectors.length !== 1)
    throw new Error(
      "Expected exactly one controller-owned cloudflared connector Deployment",
    );
  execFileSync(
    "kubectl",
    [
      ...kubeArgs,
      "-n",
      "cloudflare-tunnel-system",
      "rollout",
      "status",
      `deployment/${connectors[0].metadata.name}`,
      "--timeout=300s",
    ],
    { stdio: "inherit" },
  );
  if (process.argv.includes("--smoke")) {
    execFileSync(
      "kubectl",
      [
        ...kubeArgs,
        "-n",
        "kairos-ingress-test",
        "rollout",
        "status",
        "deployment/smoke",
        "--timeout=120s",
      ],
      { stdio: "inherit" },
    );
    const origin = execFileSync(
      "kubectl",
      [
        ...kubeArgs,
        "get",
        "--raw",
        "/api/v1/namespaces/kairos-ingress-test/services/http:smoke:80/proxy/",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (!origin.includes("Hostname: smoke-"))
      throw new Error(
        "Smoke origin did not return the expected whoami response",
      );
    const response = await globalThis.fetch(`https://${SMOKE_HOST}`, {
      redirect: "manual",
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    const location = response.headers.get("location");
    if (
      response.status !== 302 ||
      !location ||
      !new URL(location).hostname.endsWith(".cloudflareaccess.com")
    )
      throw new Error(
        `Expected Cloudflare Access login redirect; got HTTP ${response.status}`,
      );
    process.stdout.write(
      `HTTPS and unauthenticated Access enforcement passed. Complete the email-code login at https://${SMOKE_HOST} to verify the allowed identity and origin response.\n`,
    );
  }
  const tunnelResponse = await globalThis.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${cloudflare.tunnelId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: globalThis.AbortSignal.timeout(30_000),
    },
  );
  const tunnel = await tunnelResponse.json();
  if (
    !tunnelResponse.ok ||
    !tunnel.success ||
    tunnel.result.status !== "healthy"
  )
    throw new Error("Cloudflare does not report a healthy Kairos tunnel");
  process.stdout.write(
    "Kairos controller, connector, and Cloudflare tunnel health verified.\n",
  );
}
