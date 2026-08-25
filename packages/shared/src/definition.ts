import type {
  DayOfWeek,
  K3sDefinition,
  NormalizedK3sDefinition,
  UpdateWindow,
} from "./types.ts";

const DAYS: DayOfWeek[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CHANNEL = /^v1\.(\d+)$/;
const ipv4Number = (address: string): number | undefined => {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
};

export const ipv4CidrRange = (
  cidr: string,
): readonly [start: number, end: number] | undefined => {
  const [address, prefixText, extra] = cidr.split("/");
  const value = address === undefined ? undefined : ipv4Number(address);
  const prefix = Number(prefixText);
  if (
    extra !== undefined ||
    value === undefined ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return undefined;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (value & mask) >>> 0;
  if (value !== start) return undefined;
  return [start, (start | ~mask) >>> 0] as const;
};

export const validateChannel = (channel: string): `v1.${number}` => {
  if (!CHANNEL.test(channel)) {
    throw new Error(
      `K3s channel must pin one minor as v1.<minor>; received ${JSON.stringify(channel)}`,
    );
  }
  return channel as `v1.${number}`;
};

export const validateUpdateWindow = (window: UpdateWindow): UpdateWindow => {
  if (
    window.days.length === 0 ||
    window.days.some((day) => !DAYS.includes(day))
  ) {
    throw new Error("updateWindow.days must contain valid weekday names");
  }
  if (!HH_MM.test(window.startTime) || !HH_MM.test(window.endTime)) {
    throw new Error("updateWindow times must use 24-hour HH:mm form");
  }
  if (window.startTime === window.endTime) {
    throw new Error("updateWindow startTime and endTime must differ");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: window.timeZone }).format();
  } catch {
    throw new Error(
      `updateWindow.timeZone must be an IANA time zone; received ${JSON.stringify(window.timeZone)}`,
    );
  }
  return window;
};

export const normalizeK3sDefinition = (
  definition: K3sDefinition,
): NormalizedK3sDefinition => {
  const normalized: NormalizedK3sDefinition = {
    channel: validateChannel(definition.channel),
    updateWindow: validateUpdateWindow(definition.updateWindow),
    clusterCidr: definition.clusterCidr ?? "10.244.0.0/16",
    serviceCidr: definition.serviceCidr ?? "10.43.0.0/16",
    clusterDns: definition.clusterDns ?? "10.43.0.10",
    addons: {
      traefik: definition.addons?.traefik ?? true,
      metricsServer: definition.addons?.metricsServer ?? true,
    },
  };
  const ranges = [
    ["clusterCidr", normalized.clusterCidr],
    ["serviceCidr", normalized.serviceCidr],
  ] as const;
  for (const [name, cidr] of ranges) {
    if (ipv4CidrRange(cidr) === undefined) {
      throw new Error(
        `${name} must be an IPv4 CIDR; received ${JSON.stringify(cidr)}`,
      );
    }
  }
  const clusterRange = ipv4CidrRange(normalized.clusterCidr)!;
  const serviceRange = ipv4CidrRange(normalized.serviceCidr)!;
  if (
    clusterRange[0] <= serviceRange[1] &&
    serviceRange[0] <= clusterRange[1]
  ) {
    throw new Error("clusterCidr and serviceCidr must not overlap");
  }
  const dns = ipv4Number(normalized.clusterDns);
  if (dns === undefined || dns < serviceRange[0] || dns > serviceRange[1]) {
    throw new Error("clusterDns must be an IPv4 address inside serviceCidr");
  }
  return normalized;
};

const partsFor = (date: Date, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );

export const isInsideUpdateWindow = (
  window: UpdateWindow,
  date = new Date(),
): boolean => {
  validateUpdateWindow(window);
  const parts = partsFor(date, window.timeZone);
  const weekday = parts.weekday as DayOfWeek;
  const current = `${parts.hour}:${parts.minute}`;
  if (window.startTime < window.endTime) {
    return (
      window.days.includes(weekday) &&
      current >= window.startTime &&
      current < window.endTime
    );
  }
  if (current >= window.startTime) return window.days.includes(weekday);
  if (current >= window.endTime) return false;
  const previousParts = partsFor(
    new Date(date.getTime() - 12 * 60 * 60_000),
    window.timeZone,
  );
  return window.days.includes(previousParts.weekday as DayOfWeek);
};

export const assertSameMinor = (current: string, desired: string): void => {
  const currentMinor = /^v?(\d+\.\d+)\./.exec(current)?.[1];
  const desiredMinor = /^v?(\d+\.\d+)\./.exec(desired)?.[1];
  if (
    currentMinor !== undefined &&
    desiredMinor !== undefined &&
    currentMinor !== desiredMinor
  ) {
    throw new Error(
      `Automatic updates cannot change Kubernetes minor (${current} -> ${desired}); change k3s.channel explicitly`,
    );
  }
};
