import type * as Docker from "alchemy/Docker";
import type * as Kubernetes from "alchemy/Kubernetes";
import type { Resource } from "alchemy";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "./providers.ts";
import type {
  ClusterVersion,
  K3sDefinition,
  NormalizedK3sDefinition,
} from "../../shared/src/types.ts";

export type {
  DayOfWeek,
  K3sDefinition,
  UpdateWindow,
} from "../../shared/src/types.ts";

export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol?: "tcp" | "udp";
}

export interface ClusterProps {
  k3s: K3sDefinition;
  context?: Docker.Docker.ContextRef;
  /** Fixed host port for the Kubernetes API. Omit for a random free port. */
  apiPort?: number;
  /** Host mappings through k3d's server load balancer. */
  ports?: PortMapping[];
}

export interface ClusterStateProps {
  name: string;
  k3s: NormalizedK3sDefinition;
  context?: Docker.Docker.ContextRef;
  apiPort?: number;
  ports: PortMapping[];
  volume: { name: string };
  configFingerprint: string;
}

export interface ClusterAttributes {
  connection: Kubernetes.Connection;
  endpoint: string;
  kubeconfigPath: string;
  currentVersions: ClusterVersion[];
  currentVersion: string;
  channel: `v1.${number}`;
  name: string;
  volumeName: string;
  /** K3s bootstrap token retained so a replacement container can decrypt its datastore. */
  token: Redacted.Redacted<string>;
  configFingerprint: string;
}

export type ClusterResource = Resource<
  "Docker.K3s.Cluster",
  ClusterStateProps,
  ClusterAttributes,
  never,
  Providers
>;

export type Cluster = ClusterResource;
