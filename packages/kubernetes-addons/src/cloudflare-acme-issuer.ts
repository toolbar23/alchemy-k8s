import { type Input } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { CertManagerResult } from "./cert-manager.ts";
import {
  Readiness,
  Secret,
  type Readiness as ReadinessResource,
} from "./index.ts";

export const LETSENCRYPT_STAGING_URL =
  "https://acme-staging-v02.api.letsencrypt.org/directory";
export const LETSENCRYPT_PRODUCTION_URL =
  "https://acme-v02.api.letsencrypt.org/directory";

export interface CloudflareAcmeIssuerProps {
  cluster: Input<Kubernetes.ClusterLike>;
  certManager: CertManagerResult;
  zone: Cloudflare.Zone.Zone;
  email: string;
  environment: "staging" | "production";
  token?: Input<Redacted.Redacted<string>>;
  name?: string;
  timeoutSeconds?: number;
}

export interface CloudflareAcmeIssuerResult {
  name: Input<string>;
  issuerRef: {
    name: Input<string>;
    kind: "ClusterIssuer";
    group: "cert-manager.io";
  };
  environment: "staging" | "production";
  tokenManaged: boolean;
  tokenSecretName: string;
  accountKeySecretName: string;
  readiness: ReadinessResource;
}

interface CloudflareAcmeIssuerManifestProps {
  name: string;
  email: string;
  environment: "staging" | "production";
  domain: Input<string>;
  tokenSecretName: string;
  accountKeySecretName: string;
  certManagerRevision: Input<string>;
  tokenSecretRevision: Input<string>;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export const cloudflareAcmeIssuerName = (
  id: string,
  environment: "staging" | "production",
): string => {
  const suffix = `-${environment}`;
  const base =
    id
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "letsencrypt";
  return `${base.slice(0, 63 - suffix.length).replace(/-$/g, "")}${suffix}`;
};

export const cloudflareAcmeIssuerTokenPolicies = (
  zoneId: string,
): Cloudflare.ApiToken.Policy[] => [
  {
    effect: "allow",
    permissionGroups: ["Zone Read", "DNS Write"],
    resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
  },
];

export const validateCloudflareAcmeIssuerProps = (
  props: CloudflareAcmeIssuerProps,
): void => {
  const name =
    props.name ?? cloudflareAcmeIssuerName("letsencrypt", props.environment);
  if (!kubernetesName.test(name) || name.length > 63) {
    throw new Error(`Invalid Cloudflare ACME issuer name: ${name}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.email)) {
    throw new Error("Cloudflare ACME issuer email must be valid");
  }
  if (props.environment !== "staging" && props.environment !== "production") {
    throw new Error(
      "Cloudflare ACME environment must be staging or production",
    );
  }
  if (
    props.timeoutSeconds !== undefined &&
    (!Number.isFinite(props.timeoutSeconds) || props.timeoutSeconds <= 0)
  ) {
    throw new Error("Cloudflare ACME timeoutSeconds must be greater than zero");
  }
};

export const cloudflareAcmeIssuerManifest = ({
  name,
  email,
  environment,
  domain,
  tokenSecretName,
  accountKeySecretName,
  certManagerRevision,
  tokenSecretRevision,
}: CloudflareAcmeIssuerManifestProps) => ({
  apiVersion: "cert-manager.io/v1",
  kind: "ClusterIssuer",
  metadata: {
    name,
    annotations: {
      "alchemy.run/cert-manager-revision": certManagerRevision,
      "alchemy.run/token-secret-revision": tokenSecretRevision,
    },
  },
  spec: {
    acme: {
      email,
      server:
        environment === "staging"
          ? LETSENCRYPT_STAGING_URL
          : LETSENCRYPT_PRODUCTION_URL,
      privateKeySecretRef: { name: accountKeySecretName },
      solvers: [
        {
          selector: { dnsZones: [domain] },
          dns01: {
            cloudflare: {
              apiTokenSecretRef: {
                name: tokenSecretName,
                key: "api-token",
              },
            },
          },
        },
      ],
    },
  },
});

/** Create a zone-scoped Cloudflare DNS-01 ClusterIssuer. */
export const CloudflareAcmeIssuer = (
  id: string,
  props: CloudflareAcmeIssuerProps,
) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateCloudflareAcmeIssuerProps(props));

    const name = props.name ?? cloudflareAcmeIssuerName(id, props.environment);
    const tokenSecretName = `${name}-cloudflare`;
    const accountKeySecretName = `${name}-account-key`;
    let token: Input<Redacted.Redacted<string>>;
    if (props.token === undefined) {
      const managedToken = yield* Cloudflare.ApiToken.AccountApiToken(
        `${id}Token`,
        {
          accountId: props.zone.accountId,
          policies: Output.map(props.zone.zoneId, (zoneId) =>
            cloudflareAcmeIssuerTokenPolicies(zoneId),
          ),
        },
      );
      token = managedToken.value;
    } else {
      token = props.token;
    }

    const secret = yield* Secret(`${id}Secret`, {
      cluster: props.cluster,
      namespace: props.certManager.clusterResourceNamespace,
      name: tokenSecretName,
      stringData: { "api-token": token },
    });
    const tokenSecretRevision = Output.map(
      secret.resourceVersion,
      (resourceVersion) => resourceVersion ?? "unknown",
    );
    const issuer = yield* Kubernetes.Manifest(`${id}Issuer`, {
      cluster: props.cluster,
      manifest: cloudflareAcmeIssuerManifest({
        name,
        email: props.email,
        environment: props.environment,
        domain: props.zone.name,
        tokenSecretName,
        accountKeySecretName,
        certManagerRevision: props.certManager.readiness.revision,
        tokenSecretRevision,
      }),
    });
    const readiness = yield* Readiness(`${id}Readiness`, {
      cluster: issuer.connection,
      objects: [issuer.ref],
      revision: Output.map(issuer.uid, (uid) => uid ?? "applied"),
      timeoutSeconds: props.timeoutSeconds ?? 300,
    });
    const readyName = Output.map(readiness.revision, () => name);

    return {
      name: readyName,
      issuerRef: {
        name: readyName,
        kind: "ClusterIssuer",
        group: "cert-manager.io",
      },
      environment: props.environment,
      tokenManaged: props.token === undefined,
      tokenSecretName,
      accountKeySecretName,
      readiness,
    } satisfies CloudflareAcmeIssuerResult;
  });
