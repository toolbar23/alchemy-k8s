import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const STACK_FILE = path.join(
  ROOT,
  "scripts",
  "registry-e2e",
  "alchemy.run.mjs",
);

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const parseBoolean = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
};

export const openContext = () => {
  const stage = process.env.REGISTRY_E2E_STAGE ?? "manual";
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(stage) || stage.length > 40) {
    throw new Error(
      "REGISTRY_E2E_STAGE must be a Kubernetes name of at most 40 characters",
    );
  }
  const password = required("REGISTRY_E2E_PASSWORD");
  if (!/^[A-Za-z0-9._~-]{16,64}$/.test(password)) {
    throw new Error(
      "REGISTRY_E2E_PASSWORD must contain 16-64 process-safe characters",
    );
  }
  const username = process.env.REGISTRY_E2E_USERNAME ?? "registry-e2e";
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(username)) {
    throw new Error(
      "REGISTRY_E2E_USERNAME must contain 1-64 process-safe characters",
    );
  }
  const context = {
    stage,
    namespace: `registry-e2e-${stage}`,
    applicationNamespace: `registry-e2e-app-${stage}`,
    releaseName: `registry-${stage}`,
    host: required("REGISTRY_E2E_HOST"),
    username,
    password,
    kubeconfig: required("REGISTRY_E2E_KUBECONFIG"),
    kubeContext: process.env.REGISTRY_E2E_CONTEXT,
    tlsCertificateFile: required("REGISTRY_E2E_TLS_CERT_FILE"),
    tlsKeyFile: required("REGISTRY_E2E_TLS_KEY_FILE"),
    tlsVerify: parseBoolean("REGISTRY_E2E_TLS_VERIFY", true),
    s3: {
      endpoint: required("REGISTRY_E2E_S3_ENDPOINT"),
      region: required("REGISTRY_E2E_S3_REGION"),
      bucket: required("REGISTRY_E2E_S3_BUCKET"),
      accessKeyId: required("REGISTRY_E2E_S3_ACCESS_KEY_ID"),
      secretAccessKey: required("REGISTRY_E2E_S3_SECRET_ACCESS_KEY"),
      sessionToken: process.env.REGISTRY_E2E_S3_SESSION_TOKEN,
      forcePathStyle: parseBoolean("REGISTRY_E2E_S3_FORCE_PATH_STYLE", false),
      prefix: `registry-e2e/${stage}`,
    },
    reportPath: path.join(
      ROOT,
      "test-results",
      "registry",
      stage,
      "report.json",
    ),
    phases: [],
    benchmarks: {},
  };
  mkdirSync(path.dirname(context.reportPath), { recursive: true });
  return context;
};

const sanitized = (context, value) => {
  let result = value;
  for (const secret of [
    context.password,
    context.s3.accessKeyId,
    context.s3.secretAccessKey,
    context.s3.sessionToken,
  ]) {
    if (secret !== undefined && secret !== "") {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
};

export const runCommand = (
  context,
  command,
  args,
  { env = {}, input, timeoutMs = 15 * 60_000, allowFailure = false } = {},
) => {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const rawStdout = result.stdout ?? "";
  const rawStderr = result.stderr ?? "";
  const secretExposed = [
    context.password,
    context.s3.accessKeyId,
    context.s3.secretAccessKey,
    context.s3.sessionToken,
  ].some(
    (secret) =>
      secret !== undefined &&
      secret !== "" &&
      (rawStdout.includes(secret) || rawStderr.includes(secret)),
  );
  const stdout = sanitized(context, rawStdout);
  const stderr = sanitized(context, rawStderr);
  if (result.error !== undefined) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} failed with status ${String(result.status)}: ${stderr.trim()}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    secretExposed,
    durationMs: performance.now() - started,
  };
};

export const runAlchemy = (context, action, password = context.password) => {
  const commandContext = { ...context, password };
  const result = runCommand(
    commandContext,
    path.join(ROOT, "node_modules", ".bin", "alchemy"),
    [
      action,
      "--stage",
      context.stage,
      ...(action === "plan" ? [] : ["--yes"]),
      STACK_FILE,
    ],
    {
      env: {
        REGISTRY_E2E_STAGE: context.stage,
        REGISTRY_E2E_USERNAME: context.username,
        REGISTRY_E2E_PASSWORD: password,
      },
      timeoutMs: 30 * 60_000,
    },
  );
  if (result.secretExposed) {
    throw new Error("Alchemy output exposed the registry password");
  }
  return result;
};

export const kubectl = (context, args, options = {}) =>
  runCommand(
    context,
    process.env.KUBECTL_BIN ?? "kubectl",
    [
      "--kubeconfig",
      context.kubeconfig,
      ...(context.kubeContext === undefined
        ? []
        : ["--context", context.kubeContext]),
      ...args,
    ],
    options,
  );

export const waitUntil = async (
  description,
  operation,
  { timeoutMs = 5 * 60_000, intervalMs = 5_000 } = {},
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
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
};

const withAuthFile = async (context, operation) => {
  const directory = mkdtempSync(path.join(tmpdir(), "registry-e2e-auth-"));
  const authFile = path.join(directory, "auth.json");
  writeFileSync(
    authFile,
    JSON.stringify({
      auths: {
        [context.host]: {
          username: context.username,
          password: context.password,
          auth: Buffer.from(`${context.username}:${context.password}`).toString(
            "base64",
          ),
        },
      },
    }),
    { mode: 0o600 },
  );
  try {
    return await operation(authFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const copyFixtureImage = (context) =>
  withAuthFile(context, (authFile) =>
    runCommand(
      context,
      "skopeo",
      [
        "copy",
        "--all",
        "--authfile",
        authFile,
        `--dest-tls-verify=${String(context.tlsVerify)}`,
        "docker://docker.io/library/busybox:1.37.0",
        `docker://${context.host}/alchemy/e2e:latest`,
      ],
      { timeoutMs: 15 * 60_000 },
    ),
  );

export const inspectFixtureImage = (context, options = {}) =>
  withAuthFile(context, (authFile) =>
    runCommand(
      context,
      "skopeo",
      [
        "inspect",
        "--authfile",
        authFile,
        `--tls-verify=${String(context.tlsVerify)}`,
        `docker://${context.host}/alchemy/e2e:latest`,
      ],
      options,
    ),
  );

export const pullFixtureImage = (context) =>
  withAuthFile(context, async (authFile) => {
    const directory = mkdtempSync(path.join(tmpdir(), "registry-e2e-pull-"));
    try {
      return runCommand(
        context,
        "skopeo",
        [
          "copy",
          "--all",
          "--authfile",
          authFile,
          `--src-tls-verify=${String(context.tlsVerify)}`,
          `docker://${context.host}/alchemy/e2e:latest`,
          `oci:${directory}:latest`,
        ],
        { timeoutMs: 15 * 60_000 },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

export const deleteFixtureImage = (context) =>
  withAuthFile(context, (authFile) =>
    runCommand(context, "skopeo", [
      "delete",
      "--authfile",
      authFile,
      `--tls-verify=${String(context.tlsVerify)}`,
      `docker://${context.host}/alchemy/e2e:latest`,
    ]),
  );

export const registryStatus = (context, password) => {
  const curlConfiguration = [
    "silent",
    "show-error",
    'output = "/dev/null"',
    'write-out = "%{http_code}"',
    `url = "https://${context.host}/v2/"`,
    ...(password === undefined
      ? []
      : [`user = "${context.username}:${password}"`]),
  ].join("\n");
  const result = runCommand(
    context,
    "curl",
    ["--config", "-", ...(context.tlsVerify ? [] : ["--insecure"])],
    { input: curlConfiguration },
  );
  return Number(result.stdout.trim());
};

export const s3Footprint = async (context) => {
  const endpoint = new URL(context.s3.endpoint);
  if (context.s3.forcePathStyle) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/${encodeURIComponent(context.s3.bucket)}`;
  } else {
    endpoint.hostname = `${context.s3.bucket}.${endpoint.hostname}`;
  }
  let continuationToken;
  let objects = 0;
  let bytes = 0;
  do {
    const parameters = [
      ["list-type", "2"],
      ["prefix", context.s3.prefix],
      ...(continuationToken === undefined
        ? []
        : [["continuation-token", continuationToken]]),
    ].sort(([left], [right]) => left.localeCompare(right));
    const encode = (value) =>
      encodeURIComponent(value).replace(
        /[!'()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    const canonicalQuery = parameters
      .map(([name, value]) => `${encode(name)}=${encode(value)}`)
      .join("&");
    const requestUrl = new URL(endpoint);
    requestUrl.search = canonicalQuery;
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
    const date = timestamp.slice(0, 8);
    const payloadHash = createHash("sha256").update("").digest("hex");
    const canonicalUri = endpoint.pathname
      .split("/")
      .map((part) => encode(part))
      .join("/");
    const headers = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      ...(context.s3.sessionToken === undefined
        ? {}
        : { "x-amz-security-token": context.s3.sessionToken }),
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers[name].trim()}\n`)
      .join("");
    const canonicalRequest = [
      "GET",
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderNames.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${date}/${context.s3.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = createHmac("sha256", `AWS4${context.s3.secretAccessKey}`)
      .update(date)
      .digest();
    const regionKey = createHmac("sha256", dateKey)
      .update(context.s3.region)
      .digest();
    const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
    const signingKey = createHmac("sha256", serviceKey)
      .update("aws4_request")
      .digest();
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");
    const response = await globalThis.fetch(requestUrl, {
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${context.s3.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `S3 ListObjectsV2 failed with status ${String(response.status)}`,
      );
    }
    const xml = await response.text();
    for (const match of xml.matchAll(/<Size>(\d+)<\/Size>/gu)) {
      objects += 1;
      bytes += Number(match[1]);
    }
    continuationToken = xml.match(
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/u,
    )?.[1];
  } while (continuationToken !== undefined);
  return { objects, bytes };
};

export const recordPhase = (context, name, started, details = {}) => {
  context.phases.push({
    name,
    status: "passed",
    durationMs: Math.round(performance.now() - started),
    ...details,
  });
  writeFileSync(
    context.reportPath,
    `${JSON.stringify(
      {
        stage: context.stage,
        host: context.host,
        updatedAt: new Date().toISOString(),
        phases: context.phases,
        benchmarks: context.benchmarks,
      },
      undefined,
      2,
    )}\n`,
  );
};
