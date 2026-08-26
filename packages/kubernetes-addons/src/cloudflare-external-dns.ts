import { createHash } from "node:crypto";
import { Stack, Stage, type Input } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { ReadyHelmChart, Secret } from "./index.ts";

export const EXTERNAL_DNS_CHART_VERSION = "1.21.1";
const EXTERNAL_DNS_IMAGE_REPOSITORY =
  "registry.k8s.io/external-dns/external-dns";
const EXTERNAL_DNS_IMAGE_VERSION = "v0.21.0";
const EXTERNAL_DNS_IMAGE_DIGEST =
  "sha256:f53faaf71cb270d1ca9dce6ea0c94bfebf1a18696263487f0fbc74b9bf2bd7ff";
const EXTERNAL_DNS_IMAGE_TAG = `${EXTERNAL_DNS_IMAGE_VERSION}@${EXTERNAL_DNS_IMAGE_DIGEST}`;
export const EXTERNAL_DNS_IMAGE = `${EXTERNAL_DNS_IMAGE_REPOSITORY}:${EXTERNAL_DNS_IMAGE_TAG}`;

export interface CloudflareExternalDnsProps {
  cluster: Input<Kubernetes.ClusterLike>;
  zone: Cloudflare.Zone.Zone;
  policy: "sync" | "upsert-only";
  proxied?: boolean;
  token?: Input<Redacted.Redacted<string>>;
  /** Optional non-secret revision for externally managed tokens. */
  tokenRevision?: Input<string>;
  namespace?: string;
  releaseName?: string;
  timeoutSeconds?: number;
}

export interface CloudflareExternalDnsResult {
  zone: Cloudflare.Zone.Zone;
  zoneId: Input<string>;
  domain: Input<string>;
  namespace: string;
  releaseName: string;
  txtOwnerId: string;
  tokenManaged: boolean;
}

interface CloudflareExternalDnsPlanProps {
  zoneId: Input<string>;
  domain: Input<string>;
  policy: "sync" | "upsert-only";
  proxied: boolean;
  releaseName: string;
  txtOwnerId: string;
  secretName: string;
  namespaceRevision: Input<string>;
  secretRevision: Input<string>;
  tokenRevision?: Input<string> | undefined;
}

export interface CloudflareExternalDnsPlan {
  values: Record<string, unknown>;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export const cloudflareExternalDnsOwnerId = (
  stack: string,
  stage: string,
  logicalId: string,
): string => {
  const identity = `${stack}/${stage}/${logicalId}`;
  const slug =
    identity
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "external-dns";
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 12);
  return `${slug}-${digest}`;
};

export const cloudflareExternalDnsTokenPolicies = (
  zoneId: string,
): Cloudflare.ApiToken.Policy[] => [
  {
    effect: "allow",
    permissionGroups: ["Zone Read", "DNS Read", "DNS Write"],
    resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
  },
];

export const validateCloudflareExternalDnsProps = (
  props: CloudflareExternalDnsProps,
): void => {
  const namespace = props.namespace ?? "external-dns";
  const releaseName = props.releaseName ?? "external-dns";
  if (!kubernetesName.test(namespace) || namespace.length > 63) {
    throw new Error(`Invalid ExternalDNS namespace: ${namespace}`);
  }
  if (!kubernetesName.test(releaseName) || releaseName.length > 53) {
    throw new Error(`Invalid ExternalDNS release name: ${releaseName}`);
  }
  if (props.policy !== "sync" && props.policy !== "upsert-only") {
    throw new Error(
      "ExternalDNS policy must be explicitly set to sync or upsert-only",
    );
  }
  if (
    typeof props.tokenRevision === "string" &&
    props.tokenRevision.trim() === ""
  ) {
    throw new Error("ExternalDNS tokenRevision must not be empty");
  }
};

export const planCloudflareExternalDns = ({
  zoneId,
  domain,
  policy,
  proxied,
  releaseName,
  txtOwnerId,
  secretName,
  namespaceRevision,
  secretRevision,
  tokenRevision,
}: CloudflareExternalDnsPlanProps): CloudflareExternalDnsPlan => ({
  values: {
    fullnameOverride: releaseName,
    image: {
      repository: EXTERNAL_DNS_IMAGE_REPOSITORY,
      tag: EXTERNAL_DNS_IMAGE_TAG,
      pullPolicy: "IfNotPresent",
    },
    replicaCount: 1,
    deploymentStrategy: { type: "Recreate" },
    provider: { name: "cloudflare" },
    sources: ["service", "ingress"],
    policy,
    registry: "txt",
    txtOwnerId,
    domainFilters: [domain],
    triggerLoopOnEvent: true,
    extraArgs: {
      "zone-id-filter": zoneId,
      "cloudflare-proxied": proxied,
      "cloudflare-dns-records-per-page": 5000,
    },
    env: [
      {
        name: "CF_API_TOKEN",
        valueFrom: {
          secretKeyRef: { name: secretName, key: "api-token" },
        },
      },
    ],
    serviceAccount: {
      create: true,
      automountServiceAccountToken: true,
    },
    automountServiceAccountToken: true,
    rbac: { create: true },
    namespaced: false,
    service: { enabled: true },
    serviceMonitor: { enabled: false },
    resources: {
      requests: { cpu: "10m", memory: "64Mi" },
      limits: { memory: "128Mi" },
    },
    podSecurityContext: {
      runAsNonRoot: true,
      fsGroup: 65534,
      seccompProfile: { type: "RuntimeDefault" },
    },
    securityContext: {
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      capabilities: { drop: ["ALL"] },
    },
    podAnnotations: {
      "alchemy.run/namespace-revision": namespaceRevision,
      "alchemy.run/secret-revision": secretRevision,
      ...(tokenRevision === undefined
        ? {}
        : { "alchemy.run/token-revision": tokenRevision }),
    },
  },
});

/** Install a zone-scoped Cloudflare ExternalDNS controller. */
export const CloudflareExternalDns = (
  id: string,
  props: CloudflareExternalDnsProps,
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateCloudflareExternalDnsProps(props));

    const stack = yield* Stack;
    const stage = yield* Stage;
    const namespaceName = props.namespace ?? "external-dns";
    const releaseName = props.releaseName ?? "external-dns";
    const txtOwnerId = cloudflareExternalDnsOwnerId(stack.name, stage, id);
    const secretName = `${releaseName}-token`;

    const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
      cluster: props.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });

    let token: Input<Redacted.Redacted<string>>;
    if (props.token === undefined) {
      const managedToken = yield* Cloudflare.ApiToken.AccountApiToken(
        `${id}Token`,
        {
          accountId: props.zone.accountId,
          policies: Output.map(props.zone.zoneId, (zoneId) =>
            cloudflareExternalDnsTokenPolicies(zoneId),
          ),
        },
      );
      token = managedToken.value;
    } else {
      token = props.token;
    }

    const secret = yield* Secret(`${id}Secret`, {
      cluster: props.cluster,
      namespace: namespace.name,
      name: secretName,
      stringData: { "api-token": token },
    });
    const namespaceRevision = Output.map(
      namespace.uid,
      (uid) => uid ?? "created",
    );
    const secretRevision = Output.map(
      secret.resourceVersion,
      (resourceVersion) => resourceVersion ?? "unknown",
    );
    const plan = planCloudflareExternalDns({
      zoneId: props.zone.zoneId,
      domain: props.zone.name,
      policy: props.policy,
      proxied: props.proxied ?? false,
      releaseName,
      txtOwnerId,
      secretName,
      namespaceRevision,
      secretRevision,
      tokenRevision: props.tokenRevision,
    });

    yield* ReadyHelmChart(`${id}Chart`, {
      cluster: props.cluster,
      chart: "external-dns",
      repo: "https://kubernetes-sigs.github.io/external-dns/",
      version: EXTERNAL_DNS_CHART_VERSION,
      releaseName,
      namespace: namespaceName,
      createNamespace: false,
      timeoutSeconds: props.timeoutSeconds ?? 300,
      values: plan.values,
    });

    return {
      zone: props.zone,
      zoneId: props.zone.zoneId,
      domain: props.zone.name,
      namespace: namespaceName,
      releaseName,
      txtOwnerId,
      tokenManaged: props.token === undefined,
    } satisfies CloudflareExternalDnsResult;
  });
