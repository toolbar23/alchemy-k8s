import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const KAIROS_CONTEXT = "kairos";
export const KAIROS_ENDPOINT = "https://192.168.178.85:6443";
export const KAIROS_KUBECONFIG = join(homedir(), ".kube", "config");
export const KAIROS_TUNNEL = "kairos";
export const SMOKE_HOST = "test.openmdta.com";

export const validateKairosTarget = (config: {
  "current-context"?: string;
  clusters?: {
    cluster?: { server?: string; "insecure-skip-tls-verify"?: boolean };
  }[];
}) => {
  if (
    config["current-context"] !== KAIROS_CONTEXT ||
    config.clusters?.length !== 1 ||
    config.clusters[0]?.cluster?.server !== KAIROS_ENDPOINT ||
    config.clusters[0]?.cluster?.["insecure-skip-tls-verify"] === true
  ) {
    throw new Error(
      `Refusing cluster operation: expected context kairos at ${KAIROS_ENDPOINT} with TLS verification`,
    );
  }
};

/** Same explicit file/context for inspection, Alchemy and operational commands. */
export const inspectKairos = (hosts?: string[]) => {
  const args = ["--kubeconfig", KAIROS_KUBECONFIG, "--context", KAIROS_CONTEXT];
  validateKairosTarget(
    JSON.parse(
      execFileSync(
        "kubectl",
        [...args, "config", "view", "--minify", "-o", "json"],
        { encoding: "utf8" },
      ),
    ),
  );
  const nodes = JSON.parse(
    execFileSync("kubectl", [...args, "get", "nodes", "-o", "json"], {
      encoding: "utf8",
      timeout: 30_000,
    }),
  ) as {
    items: {
      metadata: { name: string };
      status: {
        addresses: { type: string; address: string }[];
        conditions: { type: string; status: string }[];
      };
    }[];
  };
  if (
    !nodes.items.some(
      (node) =>
        node.metadata.name === "kairos-60a7" &&
        node.status.addresses.some(
          (address) =>
            address.type === "InternalIP" &&
            address.address === "192.168.178.85",
        ) &&
        node.status.conditions.some(
          (condition) =>
            condition.type === "Ready" && condition.status === "True",
        ),
    )
  ) {
    throw new Error("Expected Ready node kairos-60a7 at 192.168.178.85");
  }
  if (hosts) {
    const ingresses = JSON.parse(
      execFileSync(
        "kubectl",
        [...args, "get", "ingresses", "-A", "-o", "json"],
        { encoding: "utf8", timeout: 30_000 },
      ),
    ) as { items: any[] };
    for (const ingress of ingresses.items) {
      if (
        ingress.spec.ingressClassName !== "cloudflare-tunnel" &&
        ingress.metadata.annotations?.["kubernetes.io/ingress.class"] !==
          "cloudflare-tunnel"
      )
        continue;
      if (
        ingress.spec.ingressClassName !== "cloudflare-tunnel" ||
        !ingress.spec.rules?.length ||
        ingress.spec.rules.some((rule: any) => !hosts.includes(rule.host))
      ) {
        throw new Error(
          `Existing ingress ${ingress.metadata.namespace}/${ingress.metadata.name} is outside the approved hostname list; remove its tunnel route before changing the list`,
        );
      }
    }
  }
  return args;
};

export const validatePublicHosts = (hosts: string[]) => {
  if (
    hosts.length === 0 ||
    new Set(hosts).size !== hosts.length ||
    hosts.some(
      (host) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openmdta\.com$/.test(host),
    )
  ) {
    throw new Error(
      "KAIROS_PUBLIC_HOSTS must contain unique, direct subdomains of openmdta.com (no wildcards)",
    );
  }
  return hosts;
};

interface DnsRecord {
  type: string;
  name: string;
  content: string;
}

export const validateDnsOwnership = (
  host: string,
  records: DnsRecord[],
  tunnelId?: string,
) => {
  const owner = records.find(
    (record) =>
      record.type === "TXT" && record.name === `_ctic_managed.${host}`,
  );
  let owned = false;
  if (owner) {
    try {
      const value = JSON.parse(owner.content);
      owned =
        value.controller === "strrl.dev/cloudflare-tunnel-ingress-controller" &&
        value.tunnel === KAIROS_TUNNEL;
    } catch {
      /* An unknown ownership format is never adopted. */
    }
  }
  const targets = records.filter((record) => record.name === host);
  if (
    (owner && !owned) ||
    targets.some(
      (record) =>
        record.type !== "CNAME" ||
        !owned ||
        !tunnelId ||
        record.content !== `${tunnelId}.cfargotunnel.com`,
    )
  ) {
    throw new Error(
      `Refusing existing DNS record for ${host}: not owned by the kairos tunnel`,
    );
  }
};

/** All calls are read-only. Never include credentials or API response bodies in errors. */
export const inspectCloudflare = async (
  accountId: string,
  token: string,
  hosts: string[],
  fetchImpl: typeof fetch = fetch,
) => {
  validatePublicHosts(hosts);
  if (!/^[a-f0-9]{32}$/.test(accountId) || !token)
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
    );
  const request = async (path: string) => {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = (await response.json()) as { success: boolean; result: any };
    if (!response.ok || !body.success)
      throw new Error(
        `Cloudflare preflight failed: ${path.split("?")[0]} (HTTP ${response.status}). Check account setup and token permissions.`,
      );
    return body.result;
  };
  const zones = await request(
    `/zones?account.id=${accountId}&name=openmdta.com`,
  );
  const zone = zones.find(
    (item: any) =>
      item.name === "openmdta.com" && item.account.id === accountId,
  );
  if (!zone)
    throw new Error(
      "openmdta.com is not available in the configured Cloudflare account",
    );
  const tunnels = await request(
    `/accounts/${accountId}/cfd_tunnel?name=kairos&is_deleted=false`,
  );
  const matches = tunnels.filter(
    (item: any) => item.name === KAIROS_TUNNEL && !item.deleted_at,
  );
  if (matches.length > 1)
    throw new Error("More than one active tunnel named kairos exists");
  for (const host of hosts) {
    const records = await request(
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}&per_page=100`,
    );
    const ownership = await request(
      `/zones/${zone.id}/dns_records?name=${encodeURIComponent(`_ctic_managed.${host}`)}&per_page=100`,
    );
    validateDnsOwnership(host, [...records, ...ownership], matches[0]?.id);
  }
  const organization = await request(
    `/accounts/${accountId}/access/organizations`,
  );
  if (!organization.auth_domain)
    throw new Error("Enable Cloudflare Access before deploying Kairos ingress");
  const providers = await request(
    `/accounts/${accountId}/access/identity_providers`,
  );
  const otp = providers.find((item: any) => item.type === "onetimepin");
  if (!otp)
    throw new Error(
      "Enable the Cloudflare Access One-time PIN login method before deployment",
    );
  await request(`/accounts/${accountId}/access/apps?per_page=100`);
  await request(`/accounts/${accountId}/tokens`);
  return {
    zoneId: zone.id as string,
    identityProviderId: otp.id as string,
    tunnelId: matches[0]?.id as string | undefined,
  };
};
