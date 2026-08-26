import type * as Hetzner from "alchemy/Hetzner";
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

export interface WorkerPool {
  name: string;
  serverType: string;
  location: string;
  count: number;
  /** Changing this value performs a create-first rolling replacement. */
  replacementToken?: string;
  labels?: Record<string, string>;
  taints?: string[];
}

export interface EtcdS3Backup {
  endpoint: string;
  region: string;
  bucket: string;
  folder?: string;
  accessKey: Redacted.Redacted<string>;
  secretKey: Redacted.Redacted<string>;
  forcePathStyle?: boolean;
}

export interface ClusterProps {
  k3s: K3sDefinition;
  controlPlane: {
    count: 1 | 3;
    serverType: string;
    /** One location shared by all servers, or exactly one per server. */
    locations: string | string[];
  };
  workerPools: WorkerPool[];
  ssh: {
    allowedCidrs: string[];
    /** Verify that this deploy runner is included in allowedCidrs. @default true */
    validateCurrentIp?: boolean;
  };
  apiLoadBalancer?: {
    type?: string;
    location?: string;
  };
  networkCidr?: string;
  /** @default false */
  scheduleWorkloadsOnControlPlane?: boolean;
  /** @default true */
  protectAgainstDeletion?: boolean;
  etcdSnapshots?: {
    /** K3s cron expression. @default "0 * * * *" */
    schedule?: string;
    /** @default 24 */
    retention?: number;
    s3?: EtcdS3Backup;
  };
  secretsEncryption?: {
    /**
     * Required once to encrypt an existing cluster or migrate its provider
     * from aescbc to secretbox. New clusters use encryption without this flag.
     * @default false
     */
    migrateExisting?: boolean;
    /** Controlled recovery testing; the next deploy resumes after removal. */
    failureInjection?: SecretsEncryptionFailurePoint;
  };
}

export type SecretsEncryptionFailurePoint =
  | "after-snapshot"
  | "after-enable"
  | "after-control-plane-restarts"
  | "after-rotate"
  | "after-final-restarts";

export interface ServerReference {
  id: number;
  serverId: number;
  name: string;
  ipv4?: string;
  privateKey?: Redacted.Redacted<string>;
}

export interface NodeReference {
  logicalName: string;
  name: string;
  role: "server" | "agent";
  serverId: number;
  privateIp: string;
  version: string;
  token?: Redacted.Redacted<string>;
  server: ServerReference;
}

export interface NodeProps {
  name: string;
  role: "server" | "agent";
  initialServer: boolean;
  /** Internal revision that re-runs bootstrap when node configuration changes. */
  bootstrapRevision: number;
  server: ServerReference;
  bootstrap?: NodeReference;
  k3s: NormalizedK3sDefinition;
  networkCidr: string;
  apiEndpoint: string;
  scheduleWorkloadsOnControlPlane: boolean;
  labels?: Record<string, string>;
  taints?: string[];
  etcdSnapshots: {
    schedule: string;
    retention: number;
    s3?: EtcdS3Backup;
  };
  secretsEncryption?: {
    migrateExisting: boolean;
    failureInjection?: SecretsEncryptionFailurePoint;
  };
}

export type NodeResource = Resource<
  "Hetzner.K3s.Node",
  NodeProps,
  NodeReference,
  never,
  Providers
>;

export interface ClusterStateProps {
  k3s: NormalizedK3sDefinition;
  /** Pure dependency edges that hold cluster readiness behind every node. */
  nodeServerIds: number[];
  controlPlanes: NodeReference[];
  loadBalancer: {
    ipv4: string | null;
  };
  hcloudToken: Redacted.Redacted<string>;
  networkName: string;
  networkZone: string;
  protectAgainstDeletion: boolean;
  topologyFingerprint: string;
  secretsEncryption: {
    failureInjection?: SecretsEncryptionFailurePoint;
  };
}

export interface ClusterAttributes {
  connection: Kubernetes.Connection;
  endpoint: string;
  kubeconfigPath: string;
  currentVersions: ClusterVersion[];
  channel: `v1.${number}`;
  topologyFingerprint: string;
  secretsEncryption: {
    enabled: boolean;
    provider: "secretbox" | "aescbc" | undefined;
    stage: string | undefined;
    hashesMatch: boolean;
  };
}

export type ClusterResource = Resource<
  "Hetzner.K3s.Cluster",
  ClusterStateProps,
  ClusterAttributes,
  never,
  Providers
>;

/** Public return shape. It is directly accepted by Kubernetes resource inputs. */
export type Cluster = ClusterResource;

export type HetznerRequirements = Hetzner.Providers | Hetzner.Credentials;
