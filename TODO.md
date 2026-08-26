# Composable K3s roadmap

Build an opinionated K3s core with cluster-agnostic DNS, certificate, and
observability add-ons:

```text
alchemy-grafana
  └─ Grafana Cloud OTLP destination
       └─ Alchemy.Telemetry.OtlpOptions

alchemy-kubernetes-addons
  ├─ OtelCollector
  ├─ CloudflareExternalDns
  ├─ CertManager
  └─ CloudflareAcmeIssuer
       └─ all accept Kubernetes.ClusterLike

alchemy-hetzner-k3s / alchemy-docker-k3s
  └─ cluster lifecycle only
```

The add-ons belong in `alchemy-kubernetes-addons`, not a Hetzner namespace,
because this workspace already has both Hetzner and Docker K3s providers.

## Target API

```ts
const cluster =
  yield *
  HetznerK3s.Cluster("Production", {
    // Infrastructure only.
  });

// Create or explicitly adopt the shared zone once.
const zone =
  yield *
  Cloudflare.Zone.Zone("PublicZone", {
    name: "example.com",
  });

const externalDns =
  yield *
  KubernetesAddons.CloudflareExternalDns("PublicDns", {
    cluster,
    zone,
    policy: "sync",
    proxied: true,
  });

const certManager =
  yield *
  KubernetesAddons.CertManager("Certificates", {
    cluster,
  });

const letsEncrypt =
  yield *
  KubernetesAddons.CloudflareAcmeIssuer("LetsEncrypt", {
    cluster,
    certManager,
    zone,
    email: "ops@example.com",
    environment: "production",
  });

const grafana =
  yield *
  Grafana.OtlpDestination("Telemetry", {
    stackSlug: "example-production",
    otlpInstanceId: config.grafanaOtlpInstanceId,
    signals: ["traces", "logs", "metrics"],
  });

const collector =
  yield *
  KubernetesAddons.OtelCollector("TelemetryGateway", {
    cluster,
    destination: grafana.otlp,
  });
```

Applications can use Grafana directly:

```ts
vars: {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: grafana.otelTracesEndpoint,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: grafana.otelLogsEndpoint,
  OTEL_EXPORTER_OTLP_HEADERS: grafana.otelHeadersEnv,
}
```

Effect applications should use Alchemy's existing generic abstraction:

```ts
Effect.provide(Alchemy.Telemetry.layerOtlp(grafana.otlp));
```

Do not add another generic OTEL interface. `Alchemy.Telemetry.OtlpOptions`
already accepts endpoint Inputs and Redacted header Inputs.

## Phase 0: security and Kubernetes prerequisites

These tasks must be complete before Cloudflare or Grafana credentials are put
into Kubernetes.

### 0.1 First-class `KubernetesAddons.Secret`

- [x] Add a first-class `KubernetesAddons.Secret` resource using Alchemy's
      public Kubernetes adapter API.
- [x] Keep the implementation out of Alchemy core and avoid internal Alchemy
      imports.
- [x] Accept `Input<string | Redacted<string>>` for every `stringData` value.
- [x] Support explicit `name`, `namespace`, Kubernetes Secret `type`, and
      immutable Secrets.
- [x] Resolve and unwrap Redacted values only at the Kubernetes request
      boundary.
- [x] Exclude plaintext Secret data from resource attributes, plans, notes,
      errors, and diffs.
- [x] Do not read Kubernetes Secret contents back into Alchemy state.
- [x] Return only connection, name, namespace, type, UID, and resource version
      as attributes.
- [x] Update the Kubernetes Secret when a Redacted input changes.
- [x] Delete only the exact Secret owned by the resource.
- [x] Document that `Kubernetes.Manifest` is for public manifest data and
      `KubernetesAddons.Secret` is for credentials.
- [x] Document that `Kubernetes.HelmChart.values` must contain Secret references
      rather than plaintext credentials.
- [x] Add a canary test proving the secret is absent from plan-visible props,
      attributes, reads, errors, and notes. The Redacted desired input remains
      in state by design and is protected by the encrypted-state requirement.
- [x] Add a request-boundary test proving Kubernetes receives the original value
      rather than `"<redacted>"`.
- [x] Add create, update, read, idempotence, and delete tests.

Target API:

```ts
const secret =
  yield *
  KubernetesAddons.Secret("CloudflareCredentials", {
    cluster,
    namespace: "external-dns",
    name: "cloudflare-api-token",
    stringData: {
      "api-token": token.value,
    },
  });
```

### 0.2 Helm readiness

- [x] Add `KubernetesAddons.ReadyHelmChart` as a thin composition over
      `Kubernetes.HelmChart` with a bounded `timeoutSeconds` option.
- [x] Wait for `CustomResourceDefinition` objects to report `Established=True`.
- [x] Wait for Deployments to observe their generation and make the desired
      replicas available.
- [x] Wait for DaemonSets to make their desired pods available.
- [x] Wait for StatefulSets to make their desired replicas ready.
- [x] Wait for Jobs to complete or definitively fail.
- [x] Report the exact failing object and relevant conditions on timeout.
- [x] Ensure readiness errors never include Secret bodies or environment values.
- [x] Add success, terminal failure, and timeout tests.
- [x] Require the future ExternalDNS, cert-manager, and OTEL collector add-ons
      to opt into this readiness wait when they are implemented in later phases.

Target API:

```ts
yield *
  KubernetesAddons.ReadyHelmChart("CertManager", {
    // ...
    timeoutSeconds: 300,
  });
```

### 0.3 K3s Secret encryption at rest

- [x] Enable K3s Secret encryption by default for new Hetzner clusters.
- [x] Prefer the K3s `secretbox` provider when the selected version supports it.
- [x] Configure every control-plane server consistently.
- [x] Verify `k3s secrets-encrypt status` after bootstrap.
- [x] Fail safely when HA servers report mismatched encryption hashes.
- [x] Add single-control-plane E2E coverage.
- [x] Add three-control-plane E2E coverage.

Existing-cluster migration:

- [x] Take and verify an etcd snapshot before migration.
- [x] Detect the current K3s version and encryption status.
- [x] Refuse migration on K3s versions below the supported version gate.
- [x] Run enablement from the initial control-plane server.
- [x] Migrate existing `aescbc` clusters to `secretbox` only through the same
      explicit, snapshot-guarded rotation path.
- [x] Add the encryption flag and restart control planes sequentially.
- [x] Verify encryption hashes match before advancing.
- [x] Rotate and re-encrypt existing Secrets.
- [x] Verify the final state is `reencrypt_finished`.
- [x] Retain the pre-migration snapshot until the operator verifies the cluster.
- [x] Add failure injection at each migration stage.
- [x] Document the recovery procedure for an interrupted migration.

Reference: [K3s secrets encryption](https://docs.k3s.io/cli/secrets-encrypt).

### 0.4 Alchemy state protection

- [x] Document encrypted remote Alchemy state as a production requirement.
- [x] Add a production preflight warning when a stack uses an obviously local or
      unencrypted state configuration.
- [x] Document that Cloudflare, Grafana, K3s, SSH, and backup credentials are
      necessarily persisted as Redacted state inputs.
- [x] Do not implement custom state encryption in this repository.

## Phase 1: package structure

### 1.1 `alchemy-s3-access`

- [x] Add `packages/s3-access` to the root workspaces.
- [x] Make it independently publishable as the `alchemy-s3-access` npm package.
- [x] Export a provider-neutral `S3BucketAccess` contract with `endpoint`,
      `region`, `bucket`, `accessKeyId`, and Redacted `secretAccessKey` fields.
- [x] Support an optional Redacted `sessionToken` for temporary AWS STS and R2
      credentials.
- [x] Support optional `forcePathStyle` for MinIO and other S3-compatible
      providers that do not use virtual-host bucket addressing.
- [x] Keep bucket prefixes, snapshot retention, and other consumer policy out of
      the access contract.
- [x] Keep bucket creation, encryption, versioning, retention, and deletion in
      provider-specific resources; this package describes access, not ownership
      or lifecycle.
- [x] Require provider integrations to issue separately scoped credentials per
      consumer instead of sharing one account-wide key.
- [x] Keep the package independent of AWS, Cloudflare, Fly, Prisma, Hetzner, and
      Kubernetes providers.
- [x] Add build, type-check, API-shape, Redacted-secret, and package-content
      checks.

Target API:

```ts
export interface S3BucketAccess {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  forcePathStyle?: boolean;
}
```

Provider-specific resources or adapters produce `S3BucketAccess`; services such
as K3s consume only this package. A disaster-recovery bucket must be managed in
a separate retained stack so cluster destruction cannot delete its backups.

### 1.2 `alchemy-kubernetes-addons`

- [x] Add `packages/kubernetes-addons` to the root workspaces.
- [x] Make it independently publishable as `alchemy-kubernetes-addons`.
- [x] Add peer dependencies on compatible `alchemy` and `effect` versions.
- [x] Keep it independent of `alchemy-hetzner-k3s` and `alchemy-docker-k3s`.
- [x] Keep `OtelCollector`, `CloudflareExternalDns`, `CertManager`, and
      `CloudflareAcmeIssuer` out until their implementation phases rather than
      publishing placeholder exports.
- [x] Limit its provider collection to resources Alchemy does not already
      represent: safe Secret ownership and dependent readiness gates.
- [x] Add build, type-check, test, and package-content checks.

### 1.3 `alchemy-grafana`

- [x] Add `packages/grafana` to the root workspaces.
- [x] Make it independently publishable as `alchemy-grafana`.
- [x] Export a credential provider for `GRAFANA_CLOUD_ACCESS_TOKEN` and
      `GRAFANA_CLOUD_ORG_SLUG`, keeping the token Redacted.
- [x] Defer the provider collection until Phase 2 adds the first Grafana
      resource; an empty collection would be inert scaffolding.
- [x] Keep stack lookup, access policies, tokens, connectivity discovery, and
      OTLP composition in Phase 2.
- [x] Add build, type-check, test, and package-content checks.

Do not initially add stack creation, dashboards, alerts, users, teams, service
accounts, or self-hosted Loki/Tempo/Mimir.

## Phase 2: Grafana Cloud OTLP provider

### 2.1 Authentication

- [x] Support `GRAFANA_CLOUD_ACCESS_TOKEN`.
- [x] Support `GRAFANA_CLOUD_ORG_SLUG`.
- [ ] Integrate with Alchemy's normal profile and provider flow.
- [ ] Validate that the deployment credential can read the selected stack and
      its connectivity information.
- [ ] Validate that it can manage stack-scoped access policies and tokens.
- [ ] Return actionable permission errors without echoing credentials.

### 2.2 Provider resources

- [ ] Implement `Grafana.AccessPolicy`.
- [ ] Implement `Grafana.AccessPolicyToken`.
- [ ] Return `AccessPolicyToken.value` as `Redacted<string>`.
- [ ] Update access-policy scope changes in place.
- [ ] Replace policies when region, realm, or owning stack changes.
- [ ] Replace tokens when their identity changes.
- [ ] Delete a token before deleting its access policy.
- [ ] Require explicit adoption of existing access policies.
- [ ] Refuse token adoption without a separately supplied plaintext token.
- [ ] Replace tokens whose plaintext was lost rather than pretending they can be
      read from Grafana.
- [ ] Handle Grafana API pagination when finding policies and tokens.
- [ ] Add bounded retries and timeouts for Grafana API operations.

### 2.3 `Grafana.OtlpDestination`

- [ ] Implement `Grafana.OtlpDestination` as a composite over an access policy
      and token.
- [ ] Discover stack ID, region, and OTLP HTTP URL from the stack slug.
- [ ] Require the OTLP instance ID used as the Basic-auth username.
- [ ] Create a stack-scoped access policy containing only requested write
      scopes.
- [ ] Allow optional token expiration.
- [ ] Allow optional source CIDR restrictions.
- [ ] Build the Basic authorization header as a Redacted output.
- [ ] Expose `otelEndpoint`.
- [ ] Expose `otelTracesEndpoint`.
- [ ] Expose `otelLogsEndpoint`.
- [ ] Expose `otelMetricsEndpoint`.
- [ ] Expose `otelHeaders` for `Alchemy.Telemetry.OtlpOptions`.
- [ ] Expose Redacted `otelHeadersEnv` for standard OTEL environment variables.
- [ ] Expose `otlp` satisfying `Alchemy.Telemetry.OtlpOptions`.
- [ ] Handle trailing slashes without creating duplicate separators.

Target API:

```ts
const grafana =
  yield *
  Grafana.OtlpDestination("Telemetry", {
    stackSlug: "production",
    otlpInstanceId: config.grafanaOtlpInstanceId,
    signals: ["traces", "logs", "metrics"],
    expiresAt: optionalExpiration,
    allowedSubnets: optionalCidrs,
  });
```

References:

- [Grafana Cloud API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/cloud-api/)
- [Grafana OTLP setup](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/configure/sdk/)

### 2.4 Grafana tests

- [ ] Test minimum access-policy scopes for each signal combination.
- [ ] Test endpoint path construction.
- [ ] Test that Basic credentials remain Redacted.
- [ ] Test token replacement without exposing either plaintext value.
- [ ] Test access-policy update and replacement decisions.
- [ ] Test pagination.
- [ ] Add a live test that creates a temporary policy and token.
- [ ] Send one trace, log, and metric payload to Grafana.
- [ ] Assert successful ingestion responses.
- [ ] Delete the temporary token and policy.
- [ ] Confirm the revoked token is rejected.

## Phase 3: generic OTEL collector add-on

- [ ] Implement `KubernetesAddons.OtelCollector` for any
      `Kubernetes.ClusterLike`.
- [ ] Accept any `Alchemy.Telemetry.OtlpOptions` destination.
- [ ] Pin the OpenTelemetry Collector Helm chart.
- [ ] Pin the collector image version or digest.
- [ ] Run v1 as an in-cluster gateway Deployment.
- [ ] Expose an OTLP/HTTP receiver on port 4318.
- [ ] Add OTLP/gRPC on port 4317 only when a real consumer requires it.
- [ ] Build only the traces, logs, and metrics pipelines present in the
      destination.
- [ ] Store exporter credentials in `KubernetesAddons.Secret`.
- [ ] Reference credentials through collector environment variables rather than
      embedding them in Helm values.
- [ ] Force a rollout with a non-secret credential checksum when credentials
      rotate.
- [ ] Expose only a ClusterIP Service.
- [ ] Install through `KubernetesAddons.ReadyHelmChart`.
- [ ] Expose Axiom-compatible internal OTLP endpoint outputs.
- [ ] Type-test both Hetzner and Docker K3s clusters as inputs.
- [ ] Test that rendered chart inputs contain no plaintext credential.
- [ ] Start the collector on k3d.
- [ ] Send traces, logs, and metrics through it.
- [ ] Test credential rotation and collector rollout.
- [ ] Test removal of a signal pipeline.

Target API:

```ts
const collector =
  yield *
  KubernetesAddons.OtelCollector("Collector", {
    cluster,
    destination: grafana.otlp,
  });
```

Do not make the first collector release automatically scrape host files, every
pod's stdout, kubelet metrics, Prometheus targets, or Kubernetes events. Those
features require materially broader RBAC and should become a separate
`KubernetesTelemetryAgent` when the requirements are concrete.

## Phase 4: Cloudflare ExternalDNS add-on

### 4.1 API and ownership

- [ ] Implement `KubernetesAddons.CloudflareExternalDns` for any
      `Kubernetes.ClusterLike`.
- [ ] Require an explicit managed or explicitly adopted Cloudflare Zone
      resource.
- [ ] Require `policy: "sync" | "upsert-only"` because `sync` authorizes
      deletion.
- [ ] Support optional global Cloudflare proxy behavior.
- [ ] Accept an optional pre-created Redacted token.
- [ ] Keep the Cloudflare Zone retained by default.
- [ ] Do not hide zone creation or adoption inside ExternalDNS.

Target props:

```ts
interface CloudflareExternalDnsProps {
  cluster: Kubernetes.ClusterLike;
  zone: Cloudflare.Zone.Zone;
  policy: "sync" | "upsert-only";
  proxied?: boolean;
  token?: Input<Redacted<string>>;
}
```

### 4.2 Token and Secret

- [ ] Mint a Cloudflare account token when `token` is omitted.
- [ ] Grant only `Zone Read`, `DNS Read`, and `DNS Write`.
- [ ] Scope the token to `com.cloudflare.api.account.zone.<zoneId>`.
- [ ] Never grant an all-zone wildcard.
- [ ] Create an `external-dns` namespace.
- [ ] Store the token in `KubernetesAddons.Secret`.
- [ ] Put only the Secret name and key into Helm values.
- [ ] Add a non-secret token fingerprint annotation to the Deployment.
- [ ] Roll and wait for ExternalDNS when the token changes.
- [ ] Support an explicit `tokenRevision` only if a pre-created token cannot
      produce a safe rotation fingerprint.

### 4.3 ExternalDNS chart

- [ ] Install a pinned ExternalDNS Helm chart and image.
- [ ] Enable only the `service` and `ingress` sources initially.
- [ ] Set `provider=cloudflare`.
- [ ] Set the exact `zone-id-filter`.
- [ ] Set the exact `domain-filter`.
- [ ] Derive a stable `txt-owner-id` from stack, stage, and logical resource
      identity.
- [ ] Use the TXT registry.
- [ ] Apply the requested policy and proxy behavior.
- [ ] Configure a high Cloudflare DNS-record page size.
- [ ] Install through `KubernetesAddons.ReadyHelmChart`.
- [ ] Return zone, namespace, release name, and TXT owner ID as outputs.

Reference:
[ExternalDNS Cloudflare guide](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/).

### 4.4 Record ownership

- [ ] Document that Alchemy owns the zone, token, Secret, and controller.
- [ ] Document that ExternalDNS exclusively owns its dynamic A/CNAME and
      registry TXT records.
- [ ] Do not declare ExternalDNS-owned records with `Cloudflare.DNS.Record`.
- [ ] Reserve `_acme-challenge` TXT records for cert-manager.
- [ ] Leave registrar nameserver delegation external unless a registrar provider
      is added.
- [ ] Document that application removal under `sync` removes owned records while
      ExternalDNS is running.
- [ ] Do not perform a dangerous zone-wide sweep when the add-on itself is
      destroyed.
- [ ] Document explicit cleanup for any records left after controller
      destruction.

### 4.5 ExternalDNS tests

- [ ] Test the exact zone resource in the token policy.
- [ ] Test that no all-zone wildcard is present.
- [ ] Test that Helm values contain only Secret references.
- [ ] Test domain, zone, policy, proxy, and owner-ID arguments.
- [ ] Test owner-ID stability across idempotent applies.
- [ ] Test distinct owner IDs for distinct logical resources.
- [ ] Test token rotation and Deployment rollout.
- [ ] Live-test record creation and update.
- [ ] Live-test record removal under `sync`.
- [ ] Prove a record owned by another TXT owner is untouched.

## Phase 5: cert-manager and Let's Encrypt

### 5.1 Generic `CertManager`

- [ ] Implement `KubernetesAddons.CertManager` for any `Kubernetes.ClusterLike`.
- [ ] Create the `cert-manager` namespace.
- [ ] Install a pinned OCI cert-manager Helm chart.
- [ ] Enable and own its CRDs.
- [ ] Disable Helm-hook-dependent startup checks if Alchemy cannot execute their
      lifecycle correctly.
- [ ] Wait for CRDs, controller, webhook, and CA injector readiness.
- [ ] Return namespace, cluster-resource namespace, chart, and readiness
      outputs.
- [ ] Keep v1 opinionated; do not expose arbitrary chart-values passthrough.

Target API:

```ts
const certManager =
  yield *
  KubernetesAddons.CertManager("Certificates", {
    cluster,
  });
```

Reference:
[cert-manager Helm installation](https://cert-manager.io/docs/installation/helm/).

### 5.2 `CloudflareAcmeIssuer`

- [ ] Implement `KubernetesAddons.CloudflareAcmeIssuer`.
- [ ] Require the `CertManager` result to establish a dependency on a ready
      webhook and CRDs.
- [ ] Require an explicit Cloudflare Zone resource.
- [ ] Require a contact email.
- [ ] Require `environment: "staging" | "production"`.
- [ ] Accept an optional pre-created Redacted token.
- [ ] Mint a dedicated Cloudflare account token when none is supplied.
- [ ] Grant only `Zone Read` and `DNS Write`.
- [ ] Scope the token to the exact Cloudflare Zone.
- [ ] Store it in cert-manager's cluster-resource namespace.
- [ ] Create a `ClusterIssuer` using the correct staging or production ACME
      endpoint.
- [ ] Restrict the DNS-01 solver with `selector.dnsZones`.
- [ ] Use a stable cert-manager ACME account Secret name.
- [ ] Return a directly usable `issuerRef`.

Target props:

```ts
interface CloudflareAcmeIssuerProps {
  cluster: Kubernetes.ClusterLike;
  certManager: CertManagerResult;
  zone: Cloudflare.Zone.Zone;
  email: string;
  environment: "staging" | "production";
  token?: Input<Redacted<string>>;
}
```

Target output:

```ts
{
  name,
  issuerRef: {
    name,
    kind: "ClusterIssuer",
    group: "cert-manager.io",
  },
  environment,
}
```

Reference:
[cert-manager Cloudflare DNS-01](https://cert-manager.io/docs/configuration/acme/dns01/cloudflare/).

### 5.3 Application certificate ownership

- [ ] Document that each application owns its requested domains, Certificate,
      TLS Secret name, and Ingress/Gateway reference.
- [ ] Use ordinary `Kubernetes.Manifest` Certificate resources initially.
- [ ] Let cert-manager generate and rotate certificate private keys inside
      Kubernetes.
- [ ] Do not put issued private keys into Alchemy state.
- [ ] Do not add a custom Certificate wrapper until repeated application code
      proves it is useful.

Example:

```ts
yield *
  Kubernetes.Manifest("ApiCertificate", {
    cluster,
    manifest: {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: "api-tls",
        namespace: "api",
      },
      spec: {
        secretName: "api-tls",
        dnsNames: ["api.example.com"],
        issuerRef: issuer.issuerRef,
      },
    },
  });
```

### 5.4 Let's Encrypt E2E

- [ ] Use a delegated test zone.
- [ ] Use the Let's Encrypt staging environment in automation.
- [ ] Install cert-manager and create the Cloudflare issuer.
- [ ] Request a unique staging certificate.
- [ ] Wait for `Certificate Ready=True`.
- [ ] Verify the resulting Secret contains a certificate and private key.
- [ ] Verify the certificate chains to the staging issuer.
- [ ] Verify temporary `_acme-challenge` records disappear.
- [ ] Rotate the Cloudflare credential and issue another certificate.
- [ ] Destroy the Certificate, issuer, token, and controllers.
- [ ] Verify the Cloudflare Zone is retained.
- [ ] Add a separate manual production smoke check.

## Phase 6: documentation and examples

- [ ] Add one end-to-end example with a Hetzner cluster.
- [ ] Show explicit Cloudflare Zone creation or adoption.
- [ ] Show ExternalDNS.
- [ ] Show cert-manager and Let's Encrypt.
- [ ] Show a Grafana Cloud destination.
- [ ] Show the optional OTEL collector.
- [ ] Show an application Deployment, Service, Ingress, and Certificate.
- [ ] Document provider registration and required deployment credentials.
- [ ] Document that cluster provisioning does not own DNS, TLS, or
      observability.
- [ ] Document ExternalDNS and cert-manager record ownership boundaries.
- [ ] Document that Cloudflare tokens are separate by default for independent
      rotation and revocation.
- [ ] Document the increased coupling when one pre-created token is shared.
- [ ] Document that Zone destruction is never implicit.
- [ ] Document the deletion behavior of ExternalDNS `sync`.
- [ ] Document Kubernetes Secret encryption and encrypted Alchemy state as
      production requirements.
- [ ] Explain that Grafana Cloud is the backend while the OTEL collector is a
      transport/gateway.
- [ ] Explain that K3s metrics-server is unrelated to long-term metrics storage.

## Phase 7: validation and release gates

### 7.1 Checks for every implementation revision

- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run pack:check`.
- [ ] Run `npm audit --omit=dev`.
- [ ] Publish all public packages from a reviewed tagged release.

### 7.2 Compatibility matrix

- [ ] Type-test all add-ons against Docker K3s.
- [ ] Type-test all add-ons against Hetzner K3s.
- [ ] Render all Helm charts for both cluster types.
- [ ] Exercise controller readiness on both cluster types.
- [ ] Run the OTEL gateway on both cluster types.
- [ ] Run Cloudflare live tests on Hetzner K3s.
- [ ] Run cert-manager locally and Let's Encrypt staging on Hetzner K3s.
- [ ] Test Secret rotation on both cluster types.
- [ ] Test idempotence for every add-on.
- [ ] Test destruction safety for every add-on.

### 7.3 Security release gates

- [ ] Prove canary secrets are absent from plans, logs, attributes, and test
      artifacts.
- [ ] Verify K3s Secret encryption on live clusters.
- [ ] Exercise encrypted remote Alchemy state.
- [ ] Pin every chart version and image version or digest.
- [ ] Prove no credential is embedded in Helm values or ConfigMaps.
- [ ] Prove no Cloudflare runtime token has all-zone access.
- [ ] Prove no OTEL collector Service is public.
- [ ] Add negative tests for insufficient Cloudflare permissions.
- [ ] Bound every readiness wait and external API operation.
- [ ] Ensure cleanup failures retain exact resources rather than deleting
      broadly.

## Phase 8: cluster gap backlog

### S3 restore and automatic control-plane recovery

Portable backup access and restore proof are prerequisites for replacing an
initial control-plane server. Alchemy is not a continuously running controller:
automatic recovery means monitoring or a scheduled CI workflow invokes the same
idempotent Alchemy deployment after detecting an outage.

S3 backup integration and restore proof (P0):

- [ ] Replace the Hetzner-specific `EtcdS3Backup` credential shape with
      `S3BucketAccess` from `alchemy-s3-access`; keep the K3s snapshot folder,
      schedule, and retention in `Cluster` configuration.
- [ ] Pass an optional session token and path-style selection through every K3s
      snapshot save, list, prune, and restore operation.
- [ ] Require the backup bucket to outlive the cluster and document a separate
      retained stack with encrypted remote Alchemy state.
- [ ] Persist the original K3s server token in encrypted state and prove it can
      decrypt a snapshot after the original server has been deleted.
- [ ] List and validate remote snapshots without relying on the unavailable
      Kubernetes API or a Kubernetes S3 configuration Secret.
- [ ] Reject empty, foreign-cluster, or older-than-policy snapshots before
      restore; fail safely if K3s checksum verification identifies corruption.
- [ ] Prove S3 restore onto a new host for a single-control-plane cluster.
- [ ] Prove S3 restore and etcd membership reconstruction for an HA cluster.

Automatic initial-control-plane recovery (P1):

- [ ] Add an explicit opt-in recovery policy such as
      `restoreOnInitialControlPlaneReplacement` and `maximumSnapshotAge`.
- [ ] Distinguish greenfield bootstrap, an intact-server restart, deliberate
      destruction, and physical initial-server replacement.
- [ ] On replacement, select the newest valid snapshot within policy and restore
      it with the original server token plus explicit S3 CLI credentials.
- [ ] Make restore resumable and idempotent across interruption after server
      creation, snapshot download, etcd reset, normal K3s start, and state
      persistence.
- [ ] Refuse recovery without a valid snapshot and original token; retain the
      replacement and backups for diagnosis instead of bootstrapping an empty
      cluster under the old identity.
- [ ] Start K3s normally after reset and wait for datastore, API, and Secret
      encryption health before changing workers.
- [ ] Verify the API load balancer targets the replacement server.
- [ ] Reconfigure every worker from the old initial server's private IP to the
      replacement private IP, restart agents, and wait for Ready.
- [ ] Remove the obsolete Kubernetes Node object only after the replacement and
      workers are healthy.
- [ ] Prevent two monitoring or CI invocations from restoring concurrently by
      requiring a locked remote Alchemy state backend.
- [ ] Document the external health-check and scheduled/event-trigger contract;
      do not imply that Alchemy detects outages while it is not running.
- [ ] Add controlled failure injection for every recovery checkpoint.
- [ ] Add a `small-x86` disaster-recovery E2E that creates stateful cluster
      data, confirms a remote snapshot, deletes the control plane, invokes the
      recovery deployment, verifies API/workload/state recovery, and tears down
      exact owned resources.
- [ ] Record snapshot age, detection delay, replacement time, API recovery time,
      worker reconnection time, total RTO, and observable RPO in the E2E report.

### P0

- [ ] Implement SSH host identity verification.
- [ ] Add explicit server-side sshd hardening.
- [ ] Wait explicitly for cloud-init completion.
- [ ] Complete single-node, worker, and HA upgrade/protection E2E.
- [ ] Verify HCCM and CSI token rotation and rollouts.
- [ ] Pin or vendor remote bootstrap and installation artifacts.
- [ ] Pin GitHub Actions to commit SHAs.

### P1

- [ ] Add private-only management mode.
- [ ] Add Flannel `wireguard-native` support.
- [ ] Add K3s Secret-encryption key rotation.
- [ ] Add Kubernetes API audit logging.
- [ ] Enforce or strongly preflight encrypted production Alchemy state.

## Deliberately deferred

- [ ] Revisit Cilium only after a concrete network-policy or eBPF requirement.
- [ ] Revisit autoscaling only after static worker pools are insufficient.
- [ ] Revisit arbitrary operating systems only after another image is required.
- [ ] Revisit external datastores only after embedded etcd is insufficient.
- [ ] Revisit generic bootstrap hooks only after a specific extension cannot be
      represented as an add-on.
- [ ] Revisit self-hosted Grafana, Loki, Tempo, or Mimir only when Grafana Cloud
      is unsuitable.
- [ ] Add a generic DNS-provider interface only after a second implemented DNS
      provider proves the shared shape.
- [ ] Add a generic certificate wrapper only after repeated application code
      proves it useful.
- [ ] Add an add-on registry only if direct composition becomes unmanageable.
- [ ] Add registrar delegation only when an Alchemy registrar provider exists.

## Execution order

- [x] 1. Add `KubernetesAddons.Secret` without patching Alchemy core.
- [x] 2. Add composable Helm readiness without patching Alchemy core.
- [x] 3. Enable K3s Secret encryption for new clusters.
- [x] 4. Scaffold and prepare `alchemy-s3-access` for publication.
- [ ] 5. Integrate `S3BucketAccess` with K3s snapshots and prove
      single-control-plane restore.
- [ ] 6. Implement and E2E-test automatic single-control-plane recovery.
- [ ] 7. Prove HA restore and extend recovery to HA membership reconstruction.
- [x] 8. Scaffold `alchemy-kubernetes-addons`.
- [x] 9. Scaffold the `alchemy-grafana` credential boundary.
- [ ] 10. Implement the Grafana OTLP destination.
- [ ] 11. Implement the OTEL collector gateway.
- [ ] 12. Implement Cloudflare ExternalDNS.
- [ ] 13. Implement cert-manager.
- [ ] 14. Implement the Cloudflare ACME issuer.
- [ ] 15. Add local integration tests.
- [ ] 16. Run live Cloudflare, Grafana, and Let's Encrypt staging E2E.
- [ ] 17. Add documentation and examples.
- [x] 18. Add existing-cluster Secret-encryption migration.
- [ ] 19. Complete the remaining P0 cluster security work.

Each unit should be implemented in a focused JJ revision with its own tests,
description update, and a new empty revision afterward.
