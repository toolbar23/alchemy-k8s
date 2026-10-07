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
  /**
   * Kubelet settings applied to every node. Changing them re-runs the K3s installer
   * on each existing node in place, one node at a time; running containers keep running.
   */
  kubelet?: KubeletSettings;
}

export interface KubeletSettings {
  /**
   * Image garbage collection. The kubelet starts deleting unused images when the
   * image filesystem is `highThresholdPercent` full and stops at `lowThresholdPercent`.
   * Unset keeps the kubelet defaults (85 % and 80 %).
   */
  imageGc?: {
    /** Integer percentage, 1–100, above `lowThresholdPercent`. */
    highThresholdPercent: number;
    /** Integer percentage, 0–99, below `highThresholdPercent`. */
    lowThresholdPercent: number;
  };
  /**
   * Further kubelet flags as `name=value`, passed as `--kubelet-arg`. Flags the package
   * manages itself (`cloud-provider`, `provider-id`, `image-gc-*`) are rejected.
   */
  extraArgs?: string[];
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
  /** Validated kubelet flags as `name=value`, without the `--kubelet-arg` prefix. */
  kubeletArgs: string[];
}

export interface ClusterVersion {
  node: string;
  version: string;
}
