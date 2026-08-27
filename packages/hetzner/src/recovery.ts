import { createHash, createHmac } from "node:crypto";
import * as Redacted from "effect/Redacted";
import type { S3BucketAccess } from "alchemy-s3-access";
import type {
  InitialControlPlaneRecovery,
  RecoveryFailurePoint,
} from "./types.ts";

export interface RemoteEtcdSnapshot {
  key: string;
  name: string;
  size: number;
  createdAt: Date;
  etag: string;
  clusterId?: string;
  tokenHash?: string;
  nodeName?: string;
}

const hexHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac("sha256", key).update(value).digest();

const uriEncode = (value: string): string =>
  value
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

const queryEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const endpointUrl = (
  access: S3BucketAccess,
  key: string,
  query: URLSearchParams,
): URL => {
  const base = new URL(
    access.endpoint.includes("://")
      ? access.endpoint
      : `https://${access.endpoint}`,
  );
  const basePath = base.pathname.replace(/\/$/, "");
  if (access.forcePathStyle) {
    base.pathname = `${basePath}/${uriEncode(access.bucket)}/${uriEncode(key)}`;
  } else {
    base.hostname = `${access.bucket}.${base.hostname}`;
    base.pathname = `${basePath}/${uriEncode(key)}`;
  }
  base.search = query.toString();
  return base;
};

const signedRequest = (
  access: S3BucketAccess,
  method: "GET" | "HEAD",
  key: string,
  query: URLSearchParams,
  now = new Date(),
): { url: URL; headers: Headers } => {
  const url = endpointUrl(access, key, query);
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const payloadHash = hexHash("");
  const headers = new Headers({
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  });
  if (access.sessionToken !== undefined) {
    headers.set("x-amz-security-token", Redacted.value(access.sessionToken));
  }
  const canonicalHeaders = [...headers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name.toLowerCase()}:${value.trim()}\n`)
    .join("");
  const signedHeaders = [...headers.keys()]
    .map((name) => name.toLowerCase())
    .sort()
    .join(";");
  const queryEntries = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  const canonicalQuery = queryEntries
    .map(([name, value]) => `${queryEncode(name)}=${queryEncode(value)}`)
    .join("&");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${access.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    hexHash(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${Redacted.value(access.secretAccessKey)}`, date);
  const regionKey = hmac(dateKey, access.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${access.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return { url, headers };
};

const xmlValue = (source: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source)?.[1];
  if (match === undefined) return undefined;
  return match
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
};

/** List and HEAD snapshot objects directly; no K3s or Kubernetes API needed. */
export const listRemoteEtcdSnapshots = async (
  access: S3BucketAccess,
  folder = "",
  fetcher: typeof fetch = fetch,
): Promise<RemoteEtcdSnapshot[]> => {
  const prefix = folder.replace(/^\/+|\/+$/g, "");
  const objects: RemoteEtcdSnapshot[] = [];
  let continuation: string | undefined;
  do {
    const query = new URLSearchParams({
      "list-type": "2",
      prefix: prefix.length === 0 ? "" : `${prefix}/`,
    });
    if (continuation !== undefined) {
      query.set("continuation-token", continuation);
    }
    const request = signedRequest(access, "GET", "", query);
    const response = await fetcher(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Unable to list K3s snapshots: HTTP ${response.status}`);
    }
    const document = await response.text();
    for (const content of document.matchAll(
      /<Contents>([\s\S]*?)<\/Contents>/g,
    )) {
      const key = xmlValue(content[1]!, "Key");
      const size = Number(xmlValue(content[1]!, "Size"));
      const modified = xmlValue(content[1]!, "LastModified");
      const etag = xmlValue(content[1]!, "ETag")?.replaceAll('"', "");
      if (
        key === undefined ||
        !Number.isFinite(size) ||
        modified === undefined ||
        etag === undefined ||
        key.includes("/.metadata/")
      ) {
        continue;
      }
      objects.push({
        key,
        name: key.slice(key.lastIndexOf("/") + 1),
        size,
        createdAt: new Date(modified),
        etag,
      });
    }
    continuation =
      xmlValue(document, "IsTruncated") === "true"
        ? xmlValue(document, "NextContinuationToken")
        : undefined;
  } while (continuation !== undefined);

  return await Promise.all(
    objects.map(async (object) => {
      const request = signedRequest(
        access,
        "HEAD",
        object.key,
        new URLSearchParams(),
      );
      const response = await fetcher(request.url, {
        method: "HEAD",
        headers: request.headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `Unable to inspect K3s snapshot ${object.name}: HTTP ${response.status}`,
        );
      }
      return {
        ...object,
        ...(response.headers.get("x-amz-meta-k3s-cluster-id") === null
          ? {}
          : {
              clusterId: response.headers.get("x-amz-meta-k3s-cluster-id")!,
            }),
        ...(response.headers.get("x-amz-meta-k3s-token-hash") === null
          ? {}
          : {
              tokenHash: response.headers.get("x-amz-meta-k3s-token-hash")!,
            }),
        ...(response.headers.get("x-amz-meta-k3s-node-name") === null
          ? {}
          : {
              nodeName: response.headers.get("x-amz-meta-k3s-node-name")!,
            }),
      };
    }),
  );
};

export const k3sTokenHash = (token: string): string => {
  const normalized = token.trim().includes("::server:")
    ? token.trim().split("::server:").at(-1)!
    : token.trim();
  return hexHash(normalized).slice(0, 12);
};

export const selectRecoverySnapshot = (
  snapshots: RemoteEtcdSnapshot[],
  clusterId: string | undefined,
  serverToken: string,
  maximumAgeSeconds: number,
  now = new Date(),
): RemoteEtcdSnapshot => {
  const expectedHash = k3sTokenHash(serverToken);
  const valid = snapshots
    .filter(
      (snapshot) =>
        snapshot.size > 0 &&
        snapshot.clusterId !== undefined &&
        (clusterId === undefined || snapshot.clusterId === clusterId) &&
        snapshot.tokenHash === expectedHash &&
        Number.isFinite(snapshot.createdAt.getTime()) &&
        now.getTime() - snapshot.createdAt.getTime() >= 0 &&
        now.getTime() - snapshot.createdAt.getTime() <=
          maximumAgeSeconds * 1000,
    )
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  const selected = valid[0];
  const matchingClusterIds = new Set(
    valid.map((snapshot) => snapshot.clusterId),
  );
  if (
    selected === undefined ||
    (clusterId === undefined && matchingClusterIds.size !== 1)
  ) {
    throw new Error(
      `No unambiguous non-empty K3s snapshot matched ${clusterId === undefined ? "one legacy cluster identity" : `cluster ${clusterId}`}, its original server token, and maximum age ${maximumAgeSeconds}s`,
    );
  }
  return selected;
};

export const assertSafeRestoreVersion = (version: string): void => {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (parsed === null) throw new Error(`Invalid K3s version: ${version}`);
  const [, major, minor, patch] = parsed.map(Number);
  if (
    major! < 1 ||
    (major === 1 && (minor! < 35 || (minor === 35 && patch! < 3)))
  ) {
    throw new Error(
      `K3s ${version} is not safe for compressed snapshot restore; require v1.35.3 or newer`,
    );
  }
};

export const k3sS3Arguments = (
  access: S3BucketAccess,
  folder: string | undefined,
  retention: number,
): string[] => {
  const arguments_ = [
    "--etcd-s3",
    "--etcd-s3-endpoint",
    access.endpoint.replace(/^https?:\/\//, ""),
    "--etcd-s3-region",
    access.region,
    "--etcd-s3-bucket",
    access.bucket,
    "--etcd-s3-access-key",
    access.accessKeyId,
    "--etcd-s3-secret-key",
    Redacted.value(access.secretAccessKey),
    "--etcd-s3-retention",
    String(retention),
  ];
  if (access.sessionToken !== undefined) {
    arguments_.push(
      "--etcd-s3-session-token",
      Redacted.value(access.sessionToken),
    );
  }
  if (access.endpoint.startsWith("http://")) {
    arguments_.push("--etcd-s3-insecure");
  }
  if (folder !== undefined) arguments_.push("--etcd-s3-folder", folder);
  if (access.forcePathStyle) {
    arguments_.push("--etcd-s3-bucket-lookup-type", "path");
  }
  return arguments_;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const checkpoint = (
  phase: string,
  selected: RecoveryFailurePoint | undefined,
  point: RecoveryFailurePoint,
): string => `write_checkpoint ${shellQuote(phase)}
${selected === point ? `echo ${shellQuote(`Injected recovery failure at ${point}`)} >&2\nexit 97` : ""}`;

/** Resumable reset/start sequence. K3s downloads and verifies the S3 object. */
export const buildRecoveryScript = (
  snapshot: RemoteEtcdSnapshot,
  token: string,
  access: S3BucketAccess,
  folder: string | undefined,
  retention: number,
  policy: InitialControlPlaneRecovery,
): string => {
  const s3 = k3sS3Arguments(access, folder, retention)
    .map(shellQuote)
    .join(" ");
  return `set -euo pipefail
checkpoint=/var/lib/rancher/k3s/.alchemy-recovery-phase
expected_snapshot=${shellQuote(snapshot.name)}
write_checkpoint() {
  printf 'snapshot=%s\nphase=%s\n' "$expected_snapshot" "$1" > "$checkpoint.tmp"
  mv "$checkpoint.tmp" "$checkpoint"
}
install -d -m 0700 /var/lib/rancher/k3s
recorded_snapshot=$(sed -n 's/^snapshot=//p' "$checkpoint" 2>/dev/null || true)
phase=$(sed -n 's/^phase=//p' "$checkpoint" 2>/dev/null || true)
if [ -f "$checkpoint" ] && { [ "$recorded_snapshot" != "$expected_snapshot" ] || [ -z "$phase" ]; }; then
  echo "Recovery checkpoint does not match the selected snapshot" >&2
  exit 1
fi
case "$phase" in
  ""|server_created|snapshot_selected|snapshot_downloaded|etcd_reset|normal_started|complete) ;;
  *) echo "Recovery checkpoint has an unknown phase" >&2; exit 1 ;;
esac
if [ -z "$phase" ]; then
${checkpoint("server_created", policy.failureInjection, "after-server-creation")}
  phase=server_created
fi
if [ "$phase" = server_created ]; then
${checkpoint("snapshot_selected", policy.failureInjection, "after-snapshot-selection")}
  phase=snapshot_selected
fi
if [ "$phase" = snapshot_selected ] || [ "$phase" = snapshot_downloaded ]; then
  systemctl stop k3s 2>/dev/null || true
  k3s server --cluster-reset --cluster-reset-restore-path=${shellQuote(snapshot.name)} --token=${shellQuote(token)} ${s3}
${checkpoint("snapshot_downloaded", policy.failureInjection, "after-snapshot-download")}
${checkpoint("etcd_reset", policy.failureInjection, "after-etcd-reset")}
  phase=etcd_reset
fi
if [ "$phase" = etcd_reset ]; then
  systemctl start k3s
  for attempt in $(seq 1 120); do
    systemctl is-active --quiet k3s && k3s kubectl get --raw=/readyz >/dev/null 2>&1 && break
    if [ "$attempt" -eq 120 ]; then
      journalctl -u k3s --no-pager -n 100 >&2
      exit 1
    fi
    sleep 5
  done
  k3s secrets-encrypt status | grep -F 'Encryption Status: Enabled'
${checkpoint("normal_started", policy.failureInjection, "after-normal-start")}
  phase=normal_started
fi
if [ "$phase" = normal_started ]; then
${checkpoint("complete", policy.failureInjection, "after-state-persistence")}
fi
`;
};
