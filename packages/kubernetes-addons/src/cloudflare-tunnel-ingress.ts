import type { Input } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { ReadyHelmChart, Secret } from "./index.ts";

export const CLOUDFLARE_TUNNEL_CHART = "cloudflare-tunnel-ingress-controller";
export const CLOUDFLARE_TUNNEL_REPO = "https://helm.strrl.dev";
export const CLOUDFLARE_TUNNEL_VERSION = "0.1.0";
export const CLOUDFLARED_VERSION = "2026.7.3-host-metrics.1";

export interface CloudflareTunnelIngressProps {
  cluster: Input<Kubernetes.ClusterLike>;
  accountId: string;
  zoneId: string;
  tunnelName: string;
  namespace?: string;
  releaseName?: string;
  token?: Input<Redacted.Redacted<string>>;
  /** Non-secret dependency, e.g. the hostname admission binding revision. */
  dependsOn?: Input<string>;
  timeoutSeconds?: number;
}

export const cloudflareTunnelTokenPolicies = (
  accountId: string,
  zoneId: string,
): Cloudflare.ApiToken.Policy[] => [
  {
    effect: "allow",
    permissionGroups: ["Zone Read", "DNS Read", "DNS Write"],
    resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
  },
  {
    effect: "allow",
    permissionGroups: ["Cloudflare Tunnel Write"],
    resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
  },
];

export const cloudflareTunnelHelmValues = (
  releaseName: string,
  secretName: string,
  secretRevision: Input<string>,
  dependsOn: Input<string> = "none",
): Record<string, unknown> => ({
  fullnameOverride: releaseName,
  cloudflare: {
    secretRef: {
      name: secretName,
      accountIDKey: "account-id",
      tunnelNameKey: "tunnel-name",
      apiTokenKey: "api-token",
    },
  },
  ingressClass: { name: "cloudflare-tunnel", isDefaultClass: false },
  replicaCount: 1,
  image: { tag: CLOUDFLARE_TUNNEL_VERSION },
  podAnnotations: {
    "alchemy.run/secret-revision": secretRevision,
    "alchemy.run/dependency": dependsOn,
  },
  securityContext: {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
  },
  cloudflared: {
    image: { tag: CLOUDFLARED_VERSION },
    replicaCount: 1,
    podAntiAffinity: false,
    resources: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { memory: "256Mi" },
    },
  },
  serviceMonitor: { create: false },
});

/** Install an explicit-class tunnel controller with a separate scoped token.
 * The upstream controller can overwrite existing CNAMEs: callers must check
 * hostname ownership and restrict admission before handing it a shared zone.
 */
export const CloudflareTunnelIngress = (
  id: string,
  props: CloudflareTunnelIngressProps,
) =>
  Effect.gen(function* () {
    const namespaceName = props.namespace ?? "cloudflare-tunnel-system";
    const releaseName = props.releaseName ?? "cloudflare-tunnel";
    yield* Effect.try(() => {
      for (const name of [namespaceName, releaseName, props.tunnelName]) {
        if (!/^[a-z0-9](?:[-a-z0-9]{0,51}[a-z0-9])?$/.test(name)) {
          throw new Error(`Invalid Cloudflare tunnel resource name: ${name}`);
        }
      }
      for (const value of [props.accountId, props.zoneId]) {
        if (!/^[a-f0-9]{32}$/.test(value)) {
          throw new Error(
            "Cloudflare accountId and zoneId must be 32 hex digits",
          );
        }
      }
    });
    const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
      cluster: props.cluster,
      manifest: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: namespaceName },
      },
    });
    const token =
      props.token ??
      (yield* Cloudflare.ApiToken.AccountApiToken(`${id}Token`, {
        accountId: props.accountId,
        policies: cloudflareTunnelTokenPolicies(props.accountId, props.zoneId),
      })).value;
    const secretName = `${releaseName}-credentials`;
    const secret = yield* Secret(`${id}Credentials`, {
      cluster: props.cluster,
      namespace: namespace.name,
      name: secretName,
      stringData: {
        "account-id": props.accountId,
        "tunnel-name": props.tunnelName,
        "api-token": token,
      },
    });
    const chart = yield* ReadyHelmChart(`${id}Chart`, {
      cluster: props.cluster,
      chart: CLOUDFLARE_TUNNEL_CHART,
      repo: CLOUDFLARE_TUNNEL_REPO,
      version: CLOUDFLARE_TUNNEL_VERSION,
      namespace: namespaceName,
      releaseName,
      createNamespace: false,
      timeoutSeconds: props.timeoutSeconds ?? 300,
      values: cloudflareTunnelHelmValues(
        releaseName,
        secretName,
        Output.map(secret.resourceVersion, (version) => version ?? "created"),
        props.dependsOn,
      ),
    });
    return {
      namespace: namespaceName,
      releaseName,
      tunnelName: props.tunnelName,
      ingressClassName: "cloudflare-tunnel",
      chart,
    };
  });
