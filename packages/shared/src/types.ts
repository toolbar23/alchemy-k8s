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
    /**
     * Additional Helm values for K3s' bundled Traefik chart, merged into its HelmChartConfig,
     * e.g. `{ ports: { websecure: { transport: { respondingTimeouts: { readTimeout: "30m" } } } } }`.
     * The Hetzner load-balancer annotation the package sets always wins. Requires `traefik`.
     */
    traefikValues?: Record<string, unknown>;
  };
  /** K3s' built-in Flannel data plane. @default "vxlan" */
  flannelBackend?: "vxlan" | "wireguard-native";
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
    traefikValues: Record<string, unknown>;
  };
  flannelBackend: "vxlan" | "wireguard-native";
}

export interface ClusterVersion {
  node: string;
  version: string;
}
