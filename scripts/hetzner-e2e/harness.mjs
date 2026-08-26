import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import {
  PROFILES,
  STACK_NAME,
  baselineDesired,
  expectedServerCount,
  renderClusterConfig,
  requireProfile,
} from "./profiles.mjs";

const { AbortSignal, URLSearchParams, fetch } = globalThis;

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const SUITE_DIR = path.join(ROOT, "scripts", "hetzner-e2e");
export const STACK_FILE = path.join(SUITE_DIR, "alchemy.run.mjs");
export const LEDGER_DIR = path.join(ROOT, ".alchemy", "hetzner-e2e");
export const RESULTS_DIR = path.join(ROOT, "test-results", "hetzner");

const isoId = () => new Date().toISOString().replaceAll(":", "-");

export const parseCliArgs = (argv) => {
  const parsed = { profile: undefined, yes: false, runId: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--yes") {
      parsed.yes = true;
      continue;
    }
    if (argument === "--profile" || argument === "--run-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--profile") parsed.profile = value;
      if (argument === "--run-id") parsed.runId = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  requireProfile(parsed.profile);
  if (
    parsed.runId !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(parsed.runId)
  ) {
    throw new Error(
      "--run-id may contain only letters, numbers, dot, dash, and underscore",
    );
  }
  return parsed;
};

export const resolveCredentials = (environment) => {
  const alias = environment.HETZNER_API_KEY?.trim();
  const native = environment.HCLOUD_TOKEN?.trim();
  if (alias !== undefined && native !== undefined && alias !== native) {
    throw new Error(
      "HETZNER_API_KEY and HCLOUD_TOKEN are both set but differ; refusing to choose a Hetzner project",
    );
  }
  const token = native || alias;
  if (token === undefined || token.length === 0) {
    throw new Error("Set HETZNER_API_KEY or HCLOUD_TOKEN in .env");
  }
  return { token, source: native ? "HCLOUD_TOKEN" : "HETZNER_API_KEY" };
};

const loadDotEnv = async () => {
  const envPath = path.join(ROOT, ".env");
  try {
    await access(envPath, fsConstants.R_OK);
  } catch {
    throw new Error(`Missing readable environment file: ${envPath}`);
  }
  process.loadEnvFile(envPath);
  const credentials = resolveCredentials(process.env);
  process.env.HCLOUD_TOKEN = credentials.token;
  return credentials;
};

export const percentileSummary = (samples) => {
  if (samples.length === 0) throw new Error("Cannot summarize zero samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)
    ];
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  return {
    samples: sorted.length,
    min: sorted[0],
    mean: total / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
};

export const inventoryIds = (inventory) => ({
  servers: inventory.servers.map(({ id }) => id).sort((a, b) => a - b),
  networks: inventory.networks.map(({ id }) => id).sort((a, b) => a - b),
  firewalls: inventory.firewalls.map(({ id }) => id).sort((a, b) => a - b),
  loadBalancers: inventory.loadBalancers
    .map(({ id }) => id)
    .sort((a, b) => a - b),
});

export const loadBalancerIpv4 = (loadBalancer) => {
  const address =
    loadBalancer.ipv4 ?? loadBalancer.public_net?.ipv4?.ip ?? undefined;
  return typeof address === "string" ? address : undefined;
};

const redact = (context, text) => {
  let safe = text;
  for (const secret of context.secrets) {
    if (secret.length > 0) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe;
};

export const runCommand = async (
  context,
  executable,
  args,
  {
    allowFailure = false,
    env = {},
    input,
    logName = "commands",
    quiet = false,
    timeoutMs = 30 * 60_000,
  } = {},
) => {
  await mkdir(context.reportDir, { recursive: true });
  const logPath = path.join(context.reportDir, `${logName}.log`);
  const display = [executable, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
  await appendFile(logPath, `\n$ ${display}\n`, "utf8");
  if (!quiet) process.stdout.write(`\n$ ${display}\n`);
  const started = performance.now();
  const child = spawn(executable, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const safe = redact(context, chunk.toString());
    stdout += safe;
    void appendFile(logPath, safe, "utf8");
    if (!quiet) process.stdout.write(safe);
  });
  child.stderr.on("data", (chunk) => {
    const safe = redact(context, chunk.toString());
    stderr += safe;
    void appendFile(logPath, safe, "utf8");
    if (!quiet) process.stderr.write(safe);
  });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  clearTimeout(timeout);
  const durationMs = performance.now() - started;
  if (timedOut) {
    throw new Error(`${display} timed out after ${timeoutMs}ms`);
  }
  if (result.code !== 0 && !allowFailure) {
    throw new Error(
      `${display} exited ${result.code}${result.signal ? ` (${result.signal})` : ""}`,
    );
  }
  return { ...result, stdout, stderr, durationMs };
};

const ledgerPath = (profile) => path.join(LEDGER_DIR, `${profile}.json`);

export const readLedger = async (profile) => {
  try {
    return JSON.parse(await readFile(ledgerPath(profile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

export const writeLedger = async (context, ledger) => {
  await mkdir(LEDGER_DIR, { recursive: true, mode: 0o700 });
  const target = ledgerPath(context.profile);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  context.ledger = ledger;
};

export const removeLedger = async (profile) => {
  try {
    await unlink(ledgerPath(profile));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const reportPath = (context) => path.join(context.reportDir, "report.json");

const renderMarkdown = (report) => {
  const lines = [
    `# Hetzner K3s E2E — ${report.profile}`,
    "",
    `- Run: \`${report.runId}\``,
    `- Started: ${report.startedAt}`,
    `- Updated: ${report.updatedAt}`,
    `- Status: **${report.status}**`,
    "",
    "## Phases",
    "",
    "| Phase | Status | Duration |",
    "| --- | --- | ---: |",
  ];
  for (const phase of report.phases) {
    const seconds =
      phase.durationMs === undefined
        ? "—"
        : `${(phase.durationMs / 1000).toFixed(1)}s`;
    lines.push(`| ${phase.name} | ${phase.status} | ${seconds} |`);
  }
  if (Object.keys(report.checks).length > 0) {
    lines.push("", "## Checks", "");
    for (const [name, value] of Object.entries(report.checks)) {
      lines.push(`- **${name}:** \`${JSON.stringify(value)}\``);
    }
  }
  if (Object.keys(report.benchmarks).length > 0) {
    lines.push("", "## Benchmarks", "");
    for (const [name, value] of Object.entries(report.benchmarks)) {
      lines.push(`- **${name}:** \`${JSON.stringify(value)}\``);
    }
  }
  return `${lines.join("\n")}\n`;
};

export const readReport = async (context) => {
  try {
    return JSON.parse(await readFile(reportPath(context), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      runId: context.runId,
      profile: context.profile,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      phases: [],
      checks: {},
      benchmarks: {},
      resources: {},
    };
  }
};

export const updateReport = async (context, mutate) => {
  const report = await readReport(context);
  await mutate(report);
  report.updatedAt = new Date().toISOString();
  await mkdir(context.reportDir, { recursive: true });
  await writeFile(reportPath(context), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    path.join(context.reportDir, "report.md"),
    renderMarkdown(report),
  );
  return report;
};

export const recordPhase = async (context, name, status, durationMs, details) =>
  updateReport(context, (report) => {
    const phase = {
      name,
      status,
      at: new Date().toISOString(),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(details === undefined ? {} : { details }),
    };
    const existing = report.phases.findIndex((entry) => entry.name === name);
    if (existing === -1) report.phases.push(phase);
    else report.phases[existing] = phase;
    if (status === "failed") report.status = "failed";
  });

export const recordCheck = async (context, name, value) =>
  updateReport(context, (report) => {
    report.checks[name] = value;
  });

export const recordBenchmark = async (context, name, value) =>
  updateReport(context, (report) => {
    report.benchmarks[name] = value;
  });

export const finishReport = async (context, status) =>
  updateReport(context, (report) => {
    report.status = status;
    report.finishedAt = new Date().toISOString();
  });

const detectAllowedCidrs = async () => {
  const configured = process.env.HETZNER_E2E_ALLOWED_CIDRS;
  if (configured !== undefined && configured.trim().length > 0) {
    const cidrs = configured
      .split(",")
      .map((cidr) => cidr.trim())
      .filter(Boolean);
    if (
      cidrs.length === 0 ||
      cidrs.some((cidr) => !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(cidr))
    ) {
      throw new Error(
        "HETZNER_E2E_ALLOWED_CIDRS must be a comma-separated CIDR list",
      );
    }
    return cidrs;
  }
  const response = await fetch("https://ipinfo.io/ip", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to discover runner IPv4: HTTP ${response.status}`);
  }
  const address = (await response.text()).trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) {
    throw new Error(
      `Runner public address is not IPv4: ${JSON.stringify(address)}`,
    );
  }
  return [`${address}/32`];
};

export const openContext = async (argv, { requireLedger = false } = {}) => {
  const args = parseCliArgs(argv);
  const credentials = await loadDotEnv();
  const existing = await readLedger(args.profile);
  if (requireLedger && existing === undefined) {
    throw new Error(
      `No active ${args.profile} suite run; run e2e:hetzner:create first`,
    );
  }
  const runId = args.runId ?? existing?.runId ?? `${isoId()}-${args.profile}`;
  const reportDir = path.join(RESULTS_DIR, runId);
  const context = {
    ...args,
    profile: args.profile,
    profileDefinition: requireProfile(args.profile),
    stage: `e2e-${args.profile}`,
    clusterId: `e2e-${args.profile}`,
    resourceId: `e2e-${args.profile}`,
    runId,
    reportDir,
    credentials,
    token: credentials.token,
    secrets: [credentials.token],
    ledger: existing,
    allowedCidrs: await detectAllowedCidrs(),
  };
  await mkdir(reportDir, { recursive: true });
  await readReport(context);
  return context;
};

export const hcloud = async (context, endpoint, options = {}) => {
  const response = await fetch(`https://api.hetzner.cloud/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${context.token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const body = text.length === 0 ? undefined : JSON.parse(text);
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(
      `Hetzner API ${options.method ?? "GET"} ${endpoint}: ${message}`,
    );
  }
  return body;
};

export const hcloudResourceExists = async (context, plural, id) => {
  const response = await fetch(
    `https://api.hetzner.cloud/v1/${plural}/${encodeURIComponent(id)}`,
    {
      headers: { Authorization: `Bearer ${context.token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(
      `Hetzner API GET /${plural}/${id}: ${body?.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return true;
};

export const deleteHcloudResource = async (context, plural, id) => {
  const response = await fetch(
    `https://api.hetzner.cloud/v1/${plural}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${context.token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(
      `Hetzner API DELETE /${plural}/${id}: ${body?.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return true;
};

const listOwned = async (context, plural) => {
  const query = new URLSearchParams({
    label_selector: `k3s.cluster=${context.clusterId}`,
    per_page: "50",
  });
  const response = await hcloud(context, `/${plural}?${query}`);
  return response[plural];
};

export const summarizeServer = (server) => {
  const location = server.location?.name ?? server.datacenter?.location?.name;
  if (location === undefined) {
    throw new Error(`Hetzner server ${server.id} has no location`);
  }
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    labels: server.labels,
    serverType: server.server_type.name,
    location,
    ipv4: server.public_net.ipv4.ip,
    protection: server.protection,
  };
};

export const readInventory = async (context) => {
  const [servers, networks, firewalls, loadBalancers] = await Promise.all([
    listOwned(context, "servers"),
    listOwned(context, "networks"),
    listOwned(context, "firewalls"),
    listOwned(context, "load_balancers"),
  ]);
  return {
    servers: servers
      .map(summarizeServer)
      .sort((left, right) => left.id - right.id),
    networks: networks
      .map((network) => ({
        id: network.id,
        name: network.name,
        labels: network.labels,
        protection: network.protection,
      }))
      .sort((left, right) => left.id - right.id),
    firewalls: firewalls
      .map((firewall) => ({
        id: firewall.id,
        name: firewall.name,
        labels: firewall.labels,
      }))
      .sort((left, right) => left.id - right.id),
    loadBalancers: loadBalancers
      .map((loadBalancer) => ({
        id: loadBalancer.id,
        name: loadBalancer.name,
        labels: loadBalancer.labels,
        ipv4: loadBalancerIpv4(loadBalancer),
        protection: loadBalancer.protection,
        targets: loadBalancer.targets.map((target) => target.type),
      }))
      .sort((left, right) => left.id - right.id),
  };
};

export const findLoadBalancerByIp = async (context, address) => {
  const response = await hcloud(
    context,
    `/load_balancers?${new URLSearchParams({ per_page: "50" })}`,
  );
  const matches = response.load_balancers.filter(
    (loadBalancer) => loadBalancerIpv4(loadBalancer) === address,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple Hetzner load balancers use ${address}`);
  }
  return matches[0];
};

export const assertInventory = (context, desired, inventory) => {
  const expectedServers = expectedServerCount(context.profile, desired);
  if (inventory.servers.length !== expectedServers) {
    throw new Error(
      `Expected ${expectedServers} owned servers, found ${inventory.servers.length}`,
    );
  }
  if (
    inventory.networks.length !== 1 ||
    inventory.firewalls.length !== 1 ||
    inventory.loadBalancers.length !== 1
  ) {
    throw new Error(
      `Expected one owned network/firewall/API load balancer; found ${inventory.networks.length}/${inventory.firewalls.length}/${inventory.loadBalancers.length}`,
    );
  }
  if (inventory.servers.some((server) => server.status !== "running")) {
    throw new Error("Not all Hetzner servers are running");
  }
  if (
    desired.protected &&
    (inventory.servers.some((server) => !server.protection.delete) ||
      inventory.networks.some((network) => !network.protection.delete) ||
      inventory.loadBalancers.some(
        (loadBalancer) => !loadBalancer.protection.delete,
      ))
  ) {
    throw new Error("Expected deletion protection on all protected resources");
  }
};

export const estimatePrice = async (context, desired) => {
  const response = await hcloud(context, "/pricing");
  const pricing = response.pricing;
  const locationOf = new Map();
  const profile = PROFILES[context.profile];
  for (const location of profile.controlPlane.locations) {
    locationOf.set(profile.controlPlane.serverType, location);
  }
  for (const pool of desired.workerPools) {
    locationOf.set(pool.serverType, pool.location);
  }
  let hourly = 0;
  let monthly = 0;
  const resources = [];
  const serverQuantities = new Map();
  serverQuantities.set(
    profile.controlPlane.serverType,
    (serverQuantities.get(profile.controlPlane.serverType) ?? 0) +
      profile.controlPlane.count,
  );
  for (const pool of desired.workerPools) {
    serverQuantities.set(
      pool.serverType,
      (serverQuantities.get(pool.serverType) ?? 0) + pool.count,
    );
  }
  for (const [serverType, quantity] of serverQuantities) {
    const entry = pricing.server_types.find(({ name }) => name === serverType);
    const price = entry?.prices.find(
      ({ location }) => location === locationOf.get(serverType),
    );
    if (price === undefined) {
      throw new Error(`No live price for ${serverType}`);
    }
    hourly += Number(price.price_hourly.net) * quantity;
    monthly += Number(price.price_monthly.net) * quantity;
    resources.push({ type: serverType, quantity });
  }
  const serverCount = expectedServerCount(context.profile, desired);
  const ipv4 = pricing.primary_ips.find(({ type }) => type === "ipv4")
    .prices[0];
  hourly += Number(ipv4.price_hourly.net) * serverCount;
  monthly += Number(ipv4.price_monthly.net) * serverCount;
  resources.push({ type: "primary-ipv4", quantity: serverCount });
  const lb11 = pricing.load_balancer_types
    .find(({ name }) => name === "lb11")
    .prices.find(({ location }) => location === "nbg1");
  hourly += Number(lb11.price_hourly.net) * 2;
  monthly += Number(lb11.price_monthly.net) * 2;
  resources.push({ type: "lb11 (API + Traefik)", quantity: 2 });
  return { currency: "EUR net", hourly, monthlyCap: monthly, resources };
};

export const confirmProfile = async (context, message) => {
  if (context.yes) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Interactive confirmation requires a TTY; pass --yes only after reviewing cost and scope",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question(
    `${message}\nType ${context.profile} to continue: `,
  );
  prompt.close();
  if (answer.trim() !== context.profile)
    throw new Error("Confirmation cancelled");
};

export const runAlchemy = async (
  context,
  action,
  desired,
  logName,
  { allowFailure = false } = {},
) => {
  const config = renderClusterConfig(
    context.profile,
    desired,
    context.allowedCidrs,
  );
  return runCommand(
    context,
    path.join(ROOT, "node_modules", ".bin", "alchemy"),
    [
      action,
      "--stage",
      context.stage,
      ...(action === "plan" ? [] : ["--yes"]),
      STACK_FILE,
    ],
    {
      allowFailure,
      env: {
        CI: "1",
        HCLOUD_TOKEN: context.token,
        HETZNER_E2E_CONFIG: JSON.stringify(config),
      },
      logName,
      timeoutMs: 60 * 60_000,
    },
  );
};

export const kubeconfigPath = (context) =>
  path.join(
    ROOT,
    ".alchemy",
    "kubeconfigs",
    "hetzner",
    `${context.resourceId}.yaml`,
  );

export const kubectl = async (context, args, options = {}) => {
  const file = kubeconfigPath(context);
  return runCommand(context, "kubectl", ["--kubeconfig", file, ...args], {
    ...options,
    logName: options.logName ?? "kubectl",
  });
};

export const waitUntil = async (
  description,
  operation,
  { intervalMs = 5_000, timeoutMs = 10 * 60_000 } = {},
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== false && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
};

export const assertKubeconfig = async (context) => {
  const file = kubeconfigPath(context);
  const metadata = await stat(file);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(
      `Expected kubeconfig mode 0600, got ${(metadata.mode & 0o777).toString(8)}`,
    );
  }
  const ready = await kubectl(context, ["get", "--raw=/readyz"], {
    quiet: true,
  });
  if (ready.stdout.trim() !== "ok") {
    throw new Error(`Kubernetes API is not ready: ${ready.stdout.trim()}`);
  }
  return file;
};

export const makeLedger = (context) => ({
  schemaVersion: 1,
  profile: context.profile,
  stage: context.stage,
  clusterId: context.clusterId,
  resourceId: context.resourceId,
  runId: context.runId,
  reportDir: path.relative(ROOT, context.reportDir),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  phase: "new",
  desired: baselineDesired(context.profile),
  resources: {},
  ephemerals: { loadBalancerIds: [], volumeIds: [] },
});

export const saveLedger = async (context, changes) => {
  const current = context.ledger ?? makeLedger(context);
  const next = {
    ...current,
    ...changes,
    updatedAt: new Date().toISOString(),
  };
  await writeLedger(context, next);
  return next;
};

export const phaseRank = (phase) => {
  const ranks = {
    new: 0,
    created: 1,
    checked: 2,
    benchmarked: 3,
    idempotent: 4,
    scaled: 5,
    replaced: 6,
    upgraded: 7,
    "post-upgrade-checked": 8,
    "protection-verified": 9,
  };
  return ranks[phase] ?? -1;
};

export const profileSummary = (context, desired) => ({
  profile: context.profile,
  controlPlanes: context.profileDefinition.controlPlane.count,
  workers: desired.workerPools.reduce((total, pool) => total + pool.count, 0),
  serverCount: expectedServerCount(context.profile, desired),
  channel: desired.channel,
  protected: desired.protected,
  locations: [
    ...new Set([
      ...context.profileDefinition.controlPlane.locations,
      ...desired.workerPools.map(({ location }) => location),
    ]),
  ],
});

export const STACK = STACK_NAME;
