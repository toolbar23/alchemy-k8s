import type * as Hetzner from "alchemy/Hetzner";
import type * as Kubernetes from "alchemy/Kubernetes";
import type { Resource } from "alchemy";
import type * as Redacted from "effect/Redacted";
import type { S3BucketAccess } from "alchemy-s3-access";
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

export interface EtcdSnapshotConfig {
  /** K3s cron expression. @default "0 * * * *" */
  schedule?: string;
  /** @default 24 */
  retention?: number;
  /** Prefix owned by this cluster inside the bucket. */
  folder?: string;
  /** The bucket is external and must outlive the cluster. */
  s3?: S3BucketAccess;
}

export type RecoveryFailurePoint =
  | "after-server-creation"
  | "after-snapshot-selection"
  | "after-snapshot-download"
  | "after-etcd-reset"
  | "after-normal-start"
  | "after-state-persistence";

export interface InitialControlPlaneRecovery {
  /** Explicitly permits a replacement server to restore the old cluster. */
  restoreOnInitialControlPlaneReplacement: true;
  /** Reject snapshots older than this many seconds. */
  maximumSnapshotAge: number;
  /** Changing this value deliberately replaces only control plane 1. */
  replacementToken?: string;
  /** Test-only interruption; repeat the deploy without it to resume. */
  failureInjection?: RecoveryFailurePoint;
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
  state?: {
    /** Assert provider-side encryption for an unrecognized remote state ID. */
    encryptionAtRestConfirmed?: boolean;
  };
  ssh: {
    allowedCidrs: string[];
    /** Verify that this deploy runner is included in allowedCidrs. @default true */
    validateCurrentIp?: boolean;
    /** SSH uses the private network and public node ingress is closed. */
    privateOnly?: boolean;
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
  etcdSnapshots?: EtcdSnapshotConfig;
  recovery?: InitialControlPlaneRecovery;
  apiAuditLog?: {
    /** @default true */
    enabled?: boolean;
    /** @default 30 */
    maximumAgeDays?: number;
    /** @default 10 */
    maximumBackups?: number;
    /** @default 100 */
    maximumSizeMegabytes?: number;
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
    /** Change this opaque value to perform one dynamic key rotation. */
    keyRotationToken?: string;
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
  /** Address used by the deploy runner (public or private). */
  managementAddress?: string;
  /** Pinned OpenSSH host public key created with the server. */
  hostPublicKey?: string;
}

export interface NodeReference {
  logicalName: string;
  name: string;
  role: "server" | "agent";
  serverId: number;
  privateIp: string;
  version: string;
  token?: Redacted.Redacted<string>;
  /** Kubernetes kube-system UID, persisted for S3 snapshot identity checks. */
  clusterId?: string;
  /** Old node object retained until cluster-wide recovery is healthy. */
  obsoleteNodeName?: string;
  recovery?: {
    restoredSnapshot: string;
    snapshotCreatedAt: string;
    completedAt: string;
  };
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
    folder?: string;
    s3?: S3BucketAccess;
  };
  hcloudToken: Redacted.Redacted<string>;
  privateManagement: boolean;
  stateId: string;
  recovery?: InitialControlPlaneRecovery;
  apiAuditLog: {
    enabled: boolean;
    maximumAgeDays: number;
    maximumBackups: number;
    maximumSizeMegabytes: number;
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
  nodeNames: string[];
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
    keyRotationToken?: string;
  };
  obsoleteNodeNames: string[];
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
  recovery?: {
    restoredSnapshot: string;
    snapshotCreatedAt: string;
    completedAt: string;
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
