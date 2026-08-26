import { type Input } from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { Readiness, type Readiness as ReadinessResource } from "./index.ts";

export const CERT_MANAGER_CHART = "oci://quay.io/jetstack/charts/cert-manager";
export const CERT_MANAGER_CHART_VERSION = "v1.21.1";
export const CERT_MANAGER_IMAGE_VERSION = "v1.21.1";

export interface CertManagerProps {
  cluster: Input<Kubernetes.ClusterLike>;
  namespace?: string;
  releaseName?: string;
  timeoutSeconds?: number;
}

export interface CertManagerResult {
  namespace: Input<string>;
  clusterResourceNamespace: Input<string>;
  releaseName: string;
  chart: Kubernetes.HelmChart;
  readiness: ReadinessResource;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export const validateCertManagerProps = (props: CertManagerProps): void => {
  const namespace = props.namespace ?? "cert-manager";
  const releaseName = props.releaseName ?? "cert-manager";
  if (!kubernetesName.test(namespace) || namespace.length > 63) {
    throw new Error(`Invalid cert-manager namespace: ${namespace}`);
  }
  if (!kubernetesName.test(releaseName) || releaseName.length > 53) {
    throw new Error(`Invalid cert-manager release name: ${releaseName}`);
  }
  if (
    props.timeoutSeconds !== undefined &&
    (!Number.isFinite(props.timeoutSeconds) || props.timeoutSeconds <= 0)
  ) {
    throw new Error("cert-manager timeoutSeconds must be greater than zero");
  }
};

export const certManagerHelmValues = (
  namespace: string,
  namespaceRevision: Input<string>,
): Record<string, unknown> => ({
  crds: { enabled: true, keep: true },
  startupapicheck: { enabled: false },
  global: {
    leaderElection: { namespace },
    rbac: { create: true, aggregateClusterRoles: false },
  },
  image: { tag: CERT_MANAGER_IMAGE_VERSION, pullPolicy: "IfNotPresent" },
  acmesolver: {
    image: { tag: CERT_MANAGER_IMAGE_VERSION, pullPolicy: "IfNotPresent" },
  },
  replicaCount: 1,
  automountServiceAccountToken: true,
  podAnnotations: { "alchemy.run/namespace-revision": namespaceRevision },
  resources: {
    requests: { cpu: "10m", memory: "64Mi" },
    limits: { memory: "256Mi" },
  },
  securityContext: {
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  },
  containerSecurityContext: {
    privileged: false,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  },
  webhook: {
    replicaCount: 1,
    timeoutSeconds: 10,
    automountServiceAccountToken: true,
    image: { tag: CERT_MANAGER_IMAGE_VERSION, pullPolicy: "IfNotPresent" },
    podAnnotations: { "alchemy.run/namespace-revision": namespaceRevision },
    resources: {
      requests: { cpu: "10m", memory: "32Mi" },
      limits: { memory: "128Mi" },
    },
    securityContext: {
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containerSecurityContext: {
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  },
  cainjector: {
    enabled: true,
    replicaCount: 1,
    automountServiceAccountToken: true,
    image: { tag: CERT_MANAGER_IMAGE_VERSION, pullPolicy: "IfNotPresent" },
    podAnnotations: { "alchemy.run/namespace-revision": namespaceRevision },
    resources: {
      requests: { cpu: "10m", memory: "64Mi" },
      limits: { memory: "256Mi" },
    },
    securityContext: {
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containerSecurityContext: {
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  },
  prometheus: { enabled: true, servicemonitor: { enabled: false } },
});

/** Install cert-manager and wait for its CRDs and control plane. */
export const CertManager = (id: string, props: CertManagerProps) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateCertManagerProps(props));

    const namespaceName = props.namespace ?? "cert-manager";
    const releaseName = props.releaseName ?? "cert-manager";
    const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
      cluster: props.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });
    const namespaceRevision = Output.map(
      namespace.uid,
      (uid) => uid ?? "created",
    );
    const chart = yield* Kubernetes.HelmChart(`${id}Chart`, {
      cluster: props.cluster,
      chart: CERT_MANAGER_CHART,
      version: CERT_MANAGER_CHART_VERSION,
      releaseName,
      namespace: namespace.name,
      createNamespace: false,
      includeCrds: true,
      values: certManagerHelmValues(namespaceName, namespaceRevision),
    });
    const readiness = yield* Readiness(`${id}Readiness`, {
      cluster: chart.connection,
      objects: chart.objects,
      revision: chart.code.hash,
      timeoutSeconds: props.timeoutSeconds ?? 300,
    });

    return {
      namespace: namespace.name,
      clusterResourceNamespace: namespace.name,
      releaseName,
      chart,
      readiness,
    } satisfies CertManagerResult;
  });
