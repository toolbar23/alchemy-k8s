# Composable K3s roadmap

Build an opinionated K3s core with cluster-agnostic DNS, certificate, and
observability add-ons:

```text
alchemy-s3-access
  └─ provider-neutral bucket credentials

alchemy-kubernetes-addons
  ├─ Parseable (S3 backend + bundled UI + optional Ingress)
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

const parseable =
  yield *
  KubernetesAddons.Parseable("Observability", {
    cluster,
    storage: observabilityBucket,
    staging: {
      size: "5Gi",
      storageClass: "hcloud-volumes",
    },
    ingress: {
      host: "observe.example.com",
      className: "traefik",
      tlsSecretName: "observe-tls",
    },
  });

const collector =
  yield *
  KubernetesAddons.OtelCollector("TelemetryGateway", {
    cluster,
    destination: {
      endpoints: parseable.endpoints,
      authentication: {
        type: "basic",
        secretRef: parseable.credentialsSecretRef,
      },
    },
  });
```

Applications send to the in-cluster collector, not directly to Parseable's
admin-authenticated endpoint:

```ts
vars: {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.otelTracesEndpoint,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.otelLogsEndpoint,
}
```

Effect applications should use Alchemy's existing generic abstraction:

```ts
Effect.provide(Alchemy.Telemetry.layerOtlp(collector.otlp));
```

Do not add another generic OTEL interface. `Alchemy.Telemetry.OtlpOptions`
already accepts endpoint Inputs and Redacted header Inputs. Parseable exposes
the endpoint portion plus a Kubernetes Secret reference; the collector adapter
mounts the Secret and supplies Basic authentication without distributing the
admin password to applications.

## Phase 0: security and Kubernetes prerequisites

These tasks must be complete before Cloudflare or Parseable credentials are put
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
- [x] Document that Cloudflare, Parseable, K3s, SSH, and backup credentials are
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

### 1.3 Observability backend pivot

- [x] Evaluate the Grafana Cloud scaffold against self-hosted object-storage
      backends.
- [x] Select Parseable OSS so committed telemetry lives in S3 instead of a local
      stateful database.
- [x] Remove the unused `alchemy-grafana` scaffold before it becomes a public
      compatibility commitment.
- [x] Keep Parseable in `alchemy-kubernetes-addons`; it consumes only
      `Kubernetes.ClusterLike` and `S3BucketAccess`.

## Phase 2: Parseable observability add-on

### 2.1 OSS topology and storage

- [x] Implement `KubernetesAddons.Parseable` as a composition over existing
      Alchemy resources rather than a new provider or Alchemy core patch.
- [x] Deploy the OSS standalone/unified topology whose container includes the
      web UI; do not enable the Enterprise-only distributed Prism component.
- [x] Pin Parseable Helm chart `3.2.1` and image
      `quay.io/parseablehq/parseable:v3.1.0`.
- [x] Require provider-neutral `S3BucketAccess` and configure `s3-store`.
- [x] Keep a persistent 5 GiB staging PVC by default and allow size and storage
      class overrides.
- [x] Pass `forcePathStyle` as `P_S3_PATH_STYLE`.
- [x] Reject unsupported S3 session tokens instead of silently ignoring them.
- [x] Disable update checks and anonymous usage reporting.

### 2.2 Secret and lifecycle safety

- [x] Create the Namespace before the write-only Secret and Helm release.
- [x] Generate a stable Redacted admin password with Alchemy `Random` when the
      caller does not supply one.
- [x] Keep all admin and S3 credentials out of manifests and Helm values.
- [x] Put only the existing Secret name into Helm values.
- [x] Use the Secret resource version as a non-secret pod annotation so
      credential rotation rolls the StatefulSet.
- [x] Return the Redacted admin credential for operators and a Secret reference
      for the future in-cluster collector.
- [x] Do not expose a directly consumable OTLP object containing the Parseable
      admin password.

### 2.3 OTLP outputs and optional Ingress

- [x] Expose `otelEndpoint`, `otelTracesEndpoint`, `otelLogsEndpoint`, and
      `otelMetricsEndpoint` using Axiom-compatible property names.
- [x] Expose the endpoint-only portion of `Alchemy.Telemetry.OtlpOptions`.
- [x] Keep all OTLP endpoints on the internal ClusterIP service.
- [x] Make Ingress opt-in and create it as a separate `networking.k8s.io/v1`
      manifest.
- [x] Support only host, existing ingress class, and existing TLS Secret.
- [x] Keep DNS ownership in ExternalDNS and certificate ownership in
      cert-manager/application resources.
- [x] Document that the same Ingress exposes the UI, ingestion, and query APIs.

Target API:

```ts
const parseable =
  yield *
  KubernetesAddons.Parseable("Observability", {
    cluster,
    storage: observabilityBucket,
    staging: { size: "5Gi", storageClass: "hcloud-volumes" },
    ingress: {
      host: "observe.example.com",
      className: "traefik",
      tlsSecretName: "observe-tls",
    },
  });
```

### 2.4 Verification

- [x] Test exact chart and image pins.
- [x] Test S3/path-style and staging Helm values.
- [x] Prove that Helm values contain neither access key nor secret key.
- [x] Test HTTP and existing-TLS-Secret Ingress manifests.
- [x] Test unsupported session-token and unsafe-name validation.
- [ ] Add a k3d/MinIO release-gate test that ingests logs, traces, and metrics,
      browses them in the bundled UI, replaces the pod, and verifies S3-backed
      recovery.
- [ ] Verify the exact OSS feature boundary for dashboards, metrics, and PromQL
      before documenting them as supported.
- [ ] Replace the chart's optional dataset Helm hook with a first-class,
      idempotent resource before offering retention policy inputs; the hook uses
      unpinned `curlimages/curl:latest` and Alchemy does not execute Helm hooks.

## Phase 3: generic OTEL collector add-on

- [x] Implement `KubernetesAddons.OtelCollector` for any
      `Kubernetes.ClusterLike`.
- [x] Accept endpoint options compatible with `Alchemy.Telemetry.OtlpOptions`
      plus an optional Kubernetes credential Secret reference.
- [x] Compose Parseable's signal-specific `X-P-Stream` and `X-P-Log-Source`
      headers with Basic authentication loaded from its Secret.
- [x] Pin the OpenTelemetry Collector Helm chart.
- [x] Pin the collector image by its multi-architecture digest.
- [x] Run v1 as an in-cluster gateway Deployment.
- [x] Expose an OTLP/HTTP receiver on port 4318.
- [x] Keep OTLP/gRPC on port 4317 disabled until a real consumer requires it.
- [x] Build only the traces, logs, and metrics pipelines present in the
      destination.
- [x] Store exporter header values in `KubernetesAddons.Secret` and reuse the
      destination's namespaced Secret for Basic authentication.
- [x] Reference credentials through collector environment variables rather than
      embedding them in Helm values.
- [x] Force a rollout with non-secret Secret resource versions when credentials
      rotate.
- [x] Expose only a ClusterIP Service.
- [x] Install through `KubernetesAddons.ReadyHelmChart`.
- [x] Expose Axiom-compatible internal OTLP endpoint outputs.
- [x] Type-test both Hetzner and Docker K3s clusters as inputs.
- [x] Test that rendered chart inputs contain no plaintext credential.
- [x] Render the pinned chart and validate the generated configuration with the
      pinned collector binary.
- [ ] Start the collector on k3d.
- [ ] Send traces, logs, and metrics through it.
- [ ] Test credential rotation and collector rollout.
- [x] Test removal of a signal pipeline.

Target API:

```ts
const collector =
  yield *
  KubernetesAddons.OtelCollector("Collector", {
    cluster,
    destination: {
      endpoints: parseable.endpoints,
      authentication: {
        type: "basic",
        secretRef: parseable.credentialsSecretRef,
      },
    },
  });
```

Do not make the first collector release automatically scrape host files, every
pod's stdout, kubelet metrics, Prometheus targets, or Kubernetes events. Those
features require materially broader RBAC and should become a separate
`KubernetesTelemetryAgent` when the requirements are concrete.

## Phase 4: Cloudflare ExternalDNS add-on

### 4.1 API and ownership

- [x] Implement `KubernetesAddons.CloudflareExternalDns` for any
      `Kubernetes.ClusterLike`.
- [x] Require an explicit managed or explicitly adopted Cloudflare Zone
      resource.
- [x] Require `policy: "sync" | "upsert-only"` because `sync` authorizes
      deletion.
- [x] Support optional global Cloudflare proxy behavior.
- [x] Accept an optional pre-created Redacted token.
- [x] Keep the Cloudflare Zone retained by default.
- [x] Do not hide zone creation or adoption inside ExternalDNS.

Target props:

```ts
interface CloudflareExternalDnsProps {
  cluster: Input<Kubernetes.ClusterLike>;
  zone: Cloudflare.Zone.Zone;
  policy: "sync" | "upsert-only";
  proxied?: boolean;
  token?: Input<Redacted<string>>;
  tokenRevision?: Input<string>;
}
```

### 4.2 Token and Secret

- [x] Mint a Cloudflare account token when `token` is omitted.
- [x] Grant only `Zone Read`, `DNS Read`, and `DNS Write`.
- [x] Scope the token to `com.cloudflare.api.account.zone.<zoneId>`.
- [x] Never grant an all-zone wildcard.
- [x] Create an `external-dns` namespace.
- [x] Store the token in `KubernetesAddons.Secret`.
- [x] Put only the Secret name and key into Helm values.
- [x] Add the Secret's non-secret resource version annotation to the Deployment.
- [x] Roll and wait for ExternalDNS when the token changes.
- [x] Support an explicit `tokenRevision` only if a pre-created token cannot
      produce a safe rotation fingerprint.

### 4.3 ExternalDNS chart

- [x] Install a pinned ExternalDNS Helm chart and digest-pinned image.
- [x] Enable only the `service` and `ingress` sources initially.
- [x] Set `provider=cloudflare`.
- [x] Set the exact `zone-id-filter`.
- [x] Set the exact `domain-filter`.
- [x] Derive a stable `txt-owner-id` from stack, stage, and logical resource
      identity.
- [x] Use the TXT registry.
- [x] Apply the requested policy and proxy behavior.
- [x] Configure Cloudflare's maximum DNS-record page size of 5,000.
- [x] Install through `KubernetesAddons.ReadyHelmChart`.
- [x] Return zone, namespace, release name, and TXT owner ID as outputs.
- [x] Render the pinned chart and run the digest-pinned image's version check.

Reference:
[ExternalDNS Cloudflare guide](https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/).

### 4.4 Record ownership

- [x] Document that Alchemy owns the zone, token, Secret, and controller.
- [x] Document that ExternalDNS exclusively owns its dynamic A/AAAA/CNAME and
      registry TXT records.
- [x] Do not declare ExternalDNS-owned records with `Cloudflare.DNS.Record`.
- [x] Reserve `_acme-challenge` TXT records for cert-manager.
- [x] Leave registrar nameserver delegation external unless a registrar provider
      is added.
- [x] Document that application removal under `sync` removes owned records while
      ExternalDNS is running.
- [x] Do not perform a dangerous zone-wide sweep when the add-on itself is
      destroyed.
- [x] Document explicit cleanup for any records left after controller
      destruction.

### 4.5 ExternalDNS tests

- [x] Test the exact zone resource in the token policy.
- [x] Test that no all-zone wildcard is present.
- [x] Test that Helm values contain only Secret references.
- [x] Test domain, zone, policy, proxy, and owner-ID arguments.
- [x] Test owner-ID stability across idempotent applies.
- [x] Test distinct owner IDs for distinct logical resources.
- [x] Test token rotation and Deployment rollout inputs.
- [x] Live-test record creation and update.
- [x] Live-test record removal under `sync`.
- [x] Prove a record owned by another TXT owner is untouched.

## Phase 5: cert-manager and Let's Encrypt

### 5.1 Generic `CertManager`

- [x] Implement `KubernetesAddons.CertManager` for any `Kubernetes.ClusterLike`.
- [x] Create the `cert-manager` namespace.
- [x] Install a pinned OCI cert-manager Helm chart.
- [x] Enable and own its CRDs.
- [x] Disable Helm-hook-dependent startup checks if Alchemy cannot execute their
      lifecycle correctly.
- [x] Wait for CRDs, controller, webhook, and CA injector readiness.
- [x] Return namespace, cluster-resource namespace, chart, and readiness
      outputs.
- [x] Keep v1 opinionated; do not expose arbitrary chart-values passthrough.

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

- [x] Implement `KubernetesAddons.CloudflareAcmeIssuer`.
- [x] Require the `CertManager` result to establish a dependency on a ready
      webhook and CRDs.
- [x] Require an explicit Cloudflare Zone resource.
- [x] Require a contact email.
- [x] Require `environment: "staging" | "production"`.
- [x] Accept an optional pre-created Redacted token.
- [x] Mint a dedicated Cloudflare account token when none is supplied.
- [x] Grant only `Zone Read` and `DNS Write`.
- [x] Scope the token to the exact Cloudflare Zone.
- [x] Store it in cert-manager's cluster-resource namespace.
- [x] Create a `ClusterIssuer` using the correct staging or production ACME
      endpoint.
- [x] Restrict the DNS-01 solver with `selector.dnsZones`.
- [x] Use a stable cert-manager ACME account Secret name.
- [x] Return a directly usable `issuerRef`.

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

- [x] Document that each application owns its requested domains, Certificate,
      TLS Secret name, and Ingress/Gateway reference.
- [x] Use ordinary `Kubernetes.Manifest` Certificate resources initially.
- [x] Let cert-manager generate and rotate certificate private keys inside
      Kubernetes.
- [x] Do not put issued private keys into Alchemy state.
- [x] Do not add a custom Certificate wrapper until repeated application code
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

- [x] Use a delegated test zone.
- [x] Use the Let's Encrypt staging environment in automation.
- [x] Install cert-manager and create the Cloudflare issuer.
- [x] Request a unique staging certificate.
- [x] Wait for `Certificate Ready=True`.
- [x] Verify the resulting Secret contains a certificate and private key.
- [x] Verify the certificate chains to the staging issuer.
- [x] Verify temporary `_acme-challenge` records disappear.
- [x] Rotate the Cloudflare credential and issue another certificate.
- [x] Destroy the Certificate, issuer, token, and controllers.
- [x] Verify the Cloudflare Zone is retained.
- [x] Add a separate manual production smoke check.

## Phase 6: documentation and examples

- [x] Add one end-to-end example with a Hetzner cluster.
- [x] Show explicit Cloudflare Zone creation or adoption.
- [x] Show ExternalDNS.
- [x] Show cert-manager and Let's Encrypt.
- [x] Show the Parseable S3 backend and optional Ingress.
- [x] Show the optional OTEL collector.
- [x] Show an application Deployment, Service, Ingress, and Certificate.
- [x] Document provider registration and required deployment credentials.
- [x] Document that cluster provisioning does not own DNS, TLS, or
      observability.
- [x] Document ExternalDNS and cert-manager record ownership boundaries.
- [x] Document that Cloudflare tokens are separate by default for independent
      rotation and revocation.
- [x] Document the increased coupling when one pre-created token is shared.
- [x] Document that Zone destruction is never implicit.
- [x] Document the deletion behavior of ExternalDNS `sync`.
- [x] Document Kubernetes Secret encryption and encrypted Alchemy state as
      production requirements.
- [x] Explain that Parseable is the backend/UI while the OTEL collector is the
      credential boundary and transport/gateway.
- [x] Explain that K3s metrics-server is unrelated to long-term metrics storage.

## Phase 7: validation and release gates

### 7.1 Checks for every implementation revision

- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm run pack:check`.
- [x] Run `npm audit --omit=dev`.
- [ ] Publish all public packages from a reviewed tagged release.

Publication is automated for every public workspace and its dry run passes. The
last item stays open until a reviewed release tag matching the workspace version
is published; Phase 7 does not manufacture that approval event.

### 7.2 Compatibility matrix

- [x] Type-test all add-ons against Docker K3s.
- [x] Type-test all add-ons against Hetzner K3s.
- [x] Render all Helm charts for both cluster types.
- [x] Exercise controller readiness on both cluster types.
- [x] Run the OTEL gateway on both cluster types.
- [x] Run Cloudflare live tests on Hetzner K3s.
- [x] Run cert-manager locally and Let's Encrypt staging on Hetzner K3s.
- [x] Test Secret rotation on both cluster types.
- [x] Test idempotence for every add-on.
- [x] Test destruction safety for every add-on.

### 7.3 Security release gates

- [x] Prove canary secrets are absent from plans, logs, attributes, and test
      artifacts.
- [x] Verify K3s Secret encryption on live clusters.
- [x] Exercise encrypted remote Alchemy state.
- [x] Pin every chart version and image version or digest.
- [x] Prove no credential is embedded in Helm values or ConfigMaps.
- [x] Prove no Cloudflare runtime token has all-zone access.
- [x] Prove the rendered OTEL collector Service is ClusterIP-only.
- [x] Add negative tests for insufficient Cloudflare permissions.
- [x] Bound every readiness wait and external API operation.
- [x] Ensure cleanup failures retain exact resources rather than deleting
      broadly.

Evidence recorded on 2026-08-26: `npm run release:check` passed with 70 tests,
zero production dependency vulnerabilities, deterministic pinned renders for all
four add-on charts, and valid package contents. The reusable stack passed
readiness, real OTLP traces/logs/metrics, Secret rotation, all-noop planning,
canary scanning, and exact destruction on local k3d and Hetzner K3s. The same
lifecycle also passed through encrypted Cloudflare state. Live Cloudflare
testing proved exact-zone read access and a 403 for DNS writes, then removed its
temporary token. Live K3s reported Secret encryption with `secretbox`; the
adopted Cloudflare Zone survived add-on destruction. The disposable Hetzner
cluster was destroyed after verification. A separate live Parseable cycle used
an ephemeral MinIO bucket, exposed all three OTLP streams through Parseable's
API, produced a seven-resource all-noop plan, and removed its namespace, PVC,
Secrets, collector, and S3 fixture exactly.

## Phase 8: cluster gap backlog

### S3 restore and automatic control-plane recovery

Portable backup access and restore proof are prerequisites for replacing an
initial control-plane server. Alchemy is not a continuously running controller:
automatic recovery means monitoring or a scheduled CI workflow invokes the same
idempotent Alchemy deployment after detecting an outage.

S3 backup integration and restore proof (P0):

- [x] Replace the Hetzner-specific `EtcdS3Backup` credential shape with
      `S3BucketAccess` from `alchemy-s3-access`; keep the K3s snapshot folder,
      schedule, and retention in `Cluster` configuration.
- [x] Pass an optional session token and path-style selection through every K3s
      snapshot save, list, prune, and restore operation.
- [x] Require the backup bucket to outlive the cluster and document a separate
      retained stack with encrypted remote Alchemy state.
- [x] Persist the original K3s server token in encrypted state and pass it only
      to a validated restore on the replacement server.
- [ ] Live-prove that the persisted token decrypts a snapshot after the original
      server has been deleted.
- [x] List and validate remote snapshots without relying on the unavailable
      Kubernetes API or a Kubernetes S3 configuration Secret.
- [x] Reject empty, foreign-cluster, or older-than-policy snapshots before
      restore; fail safely if K3s checksum verification identifies corruption.
- [ ] Prove S3 restore onto a new host for a single-control-plane cluster.
- [ ] Prove S3 restore and etcd membership reconstruction for an HA cluster.

Automatic initial-control-plane recovery (P1):

- [x] Add an explicit opt-in recovery policy such as
      `restoreOnInitialControlPlaneReplacement` and `maximumSnapshotAge`.
- [x] Distinguish greenfield bootstrap, an intact-server restart, deliberate
      destruction, and physical initial-server replacement.
- [x] On replacement, select the newest valid snapshot within policy and restore
      it with the original server token plus explicit S3 CLI credentials.
- [x] Make restore resumable and idempotent across interruption after server
      creation, snapshot download, etcd reset, normal K3s start, and state
      persistence.
- [x] Refuse recovery without a valid snapshot and original token; retain the
      replacement and backups for diagnosis instead of bootstrapping an empty
      cluster under the old identity.
- [x] Start K3s normally after reset and wait for datastore, API, and Secret
      encryption health before changing workers.
- [x] Verify the API load balancer targets the replacement server.
- [x] Reconfigure every worker from the old initial server's private IP to the
      replacement private IP, restart agents, and wait for Ready.
- [x] Remove the obsolete Kubernetes Node object only after the replacement and
      workers are healthy.
- [x] Prevent two monitoring or CI invocations from restoring concurrently by
      requiring a locked remote Alchemy state backend.
- [x] Document the external health-check and scheduled/event-trigger contract;
      do not imply that Alchemy detects outages while it is not running.
- [x] Add controlled failure injection for every recovery checkpoint.
- [x] Add a `small-x86` disaster-recovery E2E that creates stateful cluster
      data, confirms a remote snapshot, deletes the control plane, invokes the
      recovery deployment, verifies API/workload/state recovery, and tears down
      exact owned resources.
- [x] Record snapshot age, detection delay, replacement time, API recovery time,
      worker reconnection time, total RTO, and observable RPO in the E2E report.

### P0

- [x] Implement SSH host identity verification.
- [x] Add explicit server-side sshd hardening.
- [x] Wait explicitly for cloud-init completion.
- [ ] Complete single-node, worker, and HA upgrade/protection E2E.
- [x] Verify HCCM and CSI token rotation and rollouts.
- [x] Pin or vendor remote bootstrap and installation artifacts.
- [x] Pin GitHub Actions to commit SHAs.

### P1

- [x] Add private-only management mode.
- [x] Add Flannel `wireguard-native` support.
- [x] Add K3s Secret-encryption key rotation.
- [x] Add Kubernetes API audit logging.
- [x] Enforce or strongly preflight encrypted production Alchemy state.

Phase 8 implementation evidence recorded on 2026-08-26: unit tests cover the
direct SigV4 S3 inventory, token/cluster/age rejection, restore checkpoints, the
patched-version gate, OpenSSH-accepted deterministic host identities, strict
SSH, private management lookup, dynamic Secret-key rotation, and HCCM/CSI
rollouts. The destructive `small-x86`/`ha-x86` recovery harness is in place. The
unchecked restore/proof items above remain live gates: they require a retained
S3 bucket and an encrypted, TLS, locked Postgres state backend and must not be
marked proven from unit tests alone.

## Deliberately deferred

- [ ] Revisit Cilium only after a concrete network-policy or eBPF requirement.
- [ ] Revisit autoscaling only after static worker pools are insufficient.
- [ ] Revisit arbitrary operating systems only after another image is required.
- [ ] Revisit external datastores only after embedded etcd is insufficient.
- [ ] Revisit generic bootstrap hooks only after a specific extension cannot be
      represented as an add-on.
- [ ] Revisit Grafana, Loki, Tempo, or Mimir only if Parseable's concrete
      feature or scaling limits require them.
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
- [x] 5. Integrate `S3BucketAccess` with K3s snapshots and recovery.
- [ ] 5a. Live-prove single-control-plane S3 restore.
- [x] 6. Implement automatic single-control-plane recovery and its destructive
      E2E harness.
- [ ] 6a. Run the single-control-plane recovery E2E.
- [x] 7. Implement HA membership reconstruction and extend the recovery E2E to
      `ha-x86`.
- [ ] 7a. Live-prove the HA recovery path.
- [x] 8. Scaffold `alchemy-kubernetes-addons`.
- [x] 9. Retire the superseded `alchemy-grafana` credential scaffold.
- [x] 10. Implement the S3-backed Parseable add-on and optional Ingress.
- [x] 11. Implement the OTEL collector gateway.
- [x] 12. Implement Cloudflare ExternalDNS.
- [x] 13. Implement cert-manager.
- [x] 14. Implement the Cloudflare ACME issuer.
- [x] 15. Add local integration tests.
- [ ] 16. Run live Parseable, Cloudflare, and Let's Encrypt staging E2E.
- [x] 17. Add documentation and examples.
- [x] 18. Add existing-cluster Secret-encryption migration.
- [ ] 19. Complete the remaining P0 cluster security work.

Each unit should be implemented in a focused JJ revision with its own tests,
description update, and a new empty revision afterward.
