import { isIP } from "node:net";
import type { ClusterProps } from "./types.ts";

const LOCATION_ZONES: Record<string, string> = {
  nbg1: "eu-central",
  fsn1: "eu-central",
  hel1: "eu-central",
  ash: "us-east",
  hil: "us-west",
  sin: "ap-southeast",
};

const ipv4Number = (address: string): number =>
  address
    .split(".")
    .reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);

export const cidrContains = (cidr: string, address: string): boolean => {
  const [network, prefixText] = cidr.split("/");
  if (
    network === undefined ||
    prefixText === undefined ||
    isIP(network) !== 4 ||
    isIP(address) !== 4
  ) {
    return false;
  }
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(network) & mask) === (ipv4Number(address) & mask);
};

export const normalizeLocations = (props: ClusterProps): string[] => {
  const configured = props.controlPlane.locations;
  const locations = Array.isArray(configured)
    ? configured
    : Array.from({ length: props.controlPlane.count }, () => configured);
  if (locations.length !== props.controlPlane.count) {
    throw new Error(
      `controlPlane.locations must contain one or ${props.controlPlane.count} entries`,
    );
  }
  return locations;
};

export const networkZoneFor = (locations: string[]): string => {
  const zones = locations.map((location) => LOCATION_ZONES[location]);
  if (zones.some((zone) => zone === undefined)) {
    const unsupported = locations.filter(
      (location) => LOCATION_ZONES[location] === undefined,
    );
    throw new Error(`Unknown Hetzner location(s): ${unsupported.join(", ")}`);
  }
  if (new Set(zones).size !== 1) {
    throw new Error(
      "All control-plane locations must be in the same Hetzner network zone",
    );
  }
  return zones[0]!;
};

export const validateClusterProps = (props: ClusterProps): void => {
  if (props.controlPlane.count !== 1 && props.controlPlane.count !== 3) {
    throw new Error("controlPlane.count must be 1 or 3");
  }
  if (
    props.workerPools.reduce((count, pool) => count + pool.count, 0) === 0 &&
    !(props.scheduleWorkloadsOnControlPlane ?? false)
  ) {
    throw new Error(
      "At least one worker is required when control-plane scheduling is disabled",
    );
  }
  const poolNames = new Set<string>();
  for (const pool of props.workerPools) {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(pool.name)) {
      throw new Error(
        `Worker pool name ${JSON.stringify(pool.name)} is not a DNS label`,
      );
    }
    if (poolNames.has(pool.name))
      throw new Error(`Duplicate worker pool name: ${pool.name}`);
    poolNames.add(pool.name);
    if (!Number.isInteger(pool.count) || pool.count < 0) {
      throw new Error(
        `Worker pool ${pool.name} count must be a non-negative integer`,
      );
    }
    networkZoneFor([pool.location, ...normalizeLocations(props)]);
  }
  if (props.ssh.allowedCidrs.length === 0 && !props.ssh.privateOnly) {
    throw new Error("ssh.allowedCidrs must explicitly allow at least one CIDR");
  }
  for (const cidr of props.ssh.allowedCidrs) {
    const [address, prefixText, extra] = cidr.split("/");
    const family = address === undefined ? 0 : isIP(address);
    const prefix = Number(prefixText);
    if (
      extra !== undefined ||
      family === 0 ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 4 ? 32 : 128)
    ) {
      throw new Error(`Invalid SSH CIDR: ${cidr}`);
    }
  }
  const locations = normalizeLocations(props);
  networkZoneFor(locations);
  if (props.apiLoadBalancer?.location !== undefined) {
    networkZoneFor([props.apiLoadBalancer.location, ...locations]);
  }
  const retention = props.etcdSnapshots?.retention;
  if (
    retention !== undefined &&
    (!Number.isInteger(retention) || retention < 1)
  ) {
    throw new Error("etcdSnapshots.retention must be a positive integer");
  }
  if (
    props.etcdSnapshots?.folder !== undefined &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(props.etcdSnapshots.folder) ||
      props.etcdSnapshots.folder.endsWith("/"))
  ) {
    throw new Error(
      "etcdSnapshots.folder must be a non-empty S3 prefix without a trailing slash",
    );
  }
  if (props.recovery !== undefined) {
    if (props.etcdSnapshots?.s3 === undefined) {
      throw new Error("recovery requires etcdSnapshots.s3");
    }
    if (
      !Number.isInteger(props.recovery.maximumSnapshotAge) ||
      props.recovery.maximumSnapshotAge < 1
    ) {
      throw new Error("recovery.maximumSnapshotAge must be positive seconds");
    }
    if (
      props.recovery.failureInjection !== undefined &&
      ![
        "after-server-creation",
        "after-snapshot-selection",
        "after-snapshot-download",
        "after-etcd-reset",
        "after-normal-start",
        "after-state-persistence",
      ].includes(props.recovery.failureInjection)
    ) {
      throw new Error(
        `Unknown recovery.failureInjection: ${String(props.recovery.failureInjection)}`,
      );
    }
  }
  for (const [name, value] of Object.entries({
    "apiAuditLog.maximumAgeDays": props.apiAuditLog?.maximumAgeDays,
    "apiAuditLog.maximumBackups": props.apiAuditLog?.maximumBackups,
    "apiAuditLog.maximumSizeMegabytes": props.apiAuditLog?.maximumSizeMegabytes,
  })) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  const failureInjection = props.secretsEncryption?.failureInjection;
  if (
    failureInjection !== undefined &&
    ![
      "after-snapshot",
      "after-enable",
      "after-control-plane-restarts",
      "after-rotate",
      "after-final-restarts",
    ].includes(failureInjection)
  ) {
    throw new Error(
      `Unknown secretsEncryption.failureInjection: ${String(failureInjection)}`,
    );
  }
};

export const validateCurrentRunnerIp = async (
  allowedCidrs: string[],
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const response = await fetcher("https://ipinfo.io/ip", {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Unable to determine deploy runner IP: HTTP ${response.status}`,
    );
  const address = (await response.text()).trim();
  if (isIP(address) !== 4) {
    throw new Error(
      `Deploy runner address ${JSON.stringify(address)} is not IPv4`,
    );
  }
  if (!allowedCidrs.some((cidr) => cidrContains(cidr, address))) {
    throw new Error(
      `Deploy runner ${address} is not included in ssh.allowedCidrs; refusing to create unreachable servers`,
    );
  }
  return address;
};
