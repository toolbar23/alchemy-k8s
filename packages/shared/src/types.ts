export type DayOfWeek =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

export interface UpdateWindow {
  /** Days on which an update may start. */
  days: DayOfWeek[];
  /** Inclusive start in 24-hour HH:mm form. */
  startTime: `${number}:${number}`;
  /** Exclusive end in 24-hour HH:mm form. */
  endTime: `${number}:${number}`;
  /** IANA time-zone name, for example Europe/Berlin. */
  timeZone: string;
}

export interface K3sDefinition {
  /** A pinned Kubernetes minor channel such as v1.35. */
  channel: `v1.${number}`;
  /** Required maintenance window for automatic patch updates. */
  updateWindow: UpdateWindow;
  clusterCidr?: string;
  serviceCidr?: string;
  clusterDns?: string;
  addons?: {
    traefik?: boolean;
    metricsServer?: boolean;
  };
}

export interface NormalizedK3sDefinition {
  channel: `v1.${number}`;
  updateWindow: UpdateWindow;
  clusterCidr: string;
  serviceCidr: string;
  clusterDns: string;
  addons: {
    traefik: boolean;
    metricsServer: boolean;
  };
}

export interface ClusterVersion {
  node: string;
  version: string;
}
