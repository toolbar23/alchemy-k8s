# alchemy-kubernetes-addons

Composable Kubernetes resources built on Alchemy's public cluster-adapter API.
They work with any `Kubernetes.ClusterLike`, including Hetzner K3s, Docker K3s,
EKS, and kubeconfig connections.

Add the provider beside Alchemy's Kubernetes provider:

```ts
providers: Layer.mergeAll(
  Kubernetes.providers(),
  KubernetesAddons.providers(),
),
```

## Secrets

`Secret` converts literal and lazy Effect values to Effect `Redacted`, maps
Config and Output values to `Redacted` before provider diffing and state
persistence, unwraps them only in the Kubernetes PATCH request, and never
returns Secret data from reads:

```ts
const credentials =
  yield *
  KubernetesAddons.Secret("Credentials", {
    cluster,
    namespace: "external-dns",
    name: "cloudflare-api-token",
    stringData: { "api-token": token.value },
  });
```

Use `Kubernetes.Manifest` only for public manifest data. Redacted desired inputs
still exist in Alchemy state so updates can be detected; production stacks
require encrypted remote state.

## Ready Helm charts

`ReadyHelmChart` delegates rendering and ownership to Alchemy's existing
`Kubernetes.HelmChart`, then waits with a bounded deadline for CRDs,
Deployments, DaemonSets, StatefulSets, and Jobs:

```ts
const chart =
  yield *
  KubernetesAddons.ReadyHelmChart("Controller", {
    cluster,
    chart: "controller",
    repo: "https://charts.example.com",
    version: "1.2.3",
    namespace: "controller",
    timeoutSeconds: 300,
    values: { existingSecret: credentials.name },
  });
```

Credentials must be referenced by Secret name/key rather than embedded in Helm
values. Readiness errors expose object identity, status codes, replica counts,
and condition type/status only; manifest bodies and condition text are not
included.

## Cloudflare ExternalDNS

Create or explicitly adopt the Cloudflare zone separately, then pass that
resource to the add-on:

```ts
import { adopt } from "alchemy/AdoptPolicy";

const zone =
  yield *
  Cloudflare.Zone.Zone("PublicZone", {
    name: "example.com",
  }).pipe(adopt(true));

const publicDns =
  yield *
  KubernetesAddons.CloudflareExternalDns("PublicDns", {
    cluster,
    zone,
    policy: "sync",
    proxied: true,
  });
```

Omit `adopt(true)` when Alchemy should create a new zone. Cloudflare zones are
retained by default, and this add-on never creates or destroys the zone
implicitly. Registrar nameserver delegation also remains external.

Unless `token` is supplied, Alchemy mints an account-owned runtime token with
only `Zone Read`, `DNS Read`, and `DNS Write`, scoped to exactly
`com.cloudflare.api.account.zone.<zoneId>`. The deployment credential therefore
needs `Account API Tokens Write`; it additionally needs `Zone Read` to adopt a
zone or `Zone Write` to create one. Configure it using `alchemy login` or
`CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_API_TOKEN`, never as source code.

The runtime token is written through `KubernetesAddons.Secret`. Helm receives
only the Secret name/key, while the Secret resource version rolls and re-waits
the controller after rotation. A pre-created Redacted token can be passed with
an optional non-secret `tokenRevision` when its rotation cannot otherwise be
observed safely.

ExternalDNS watches only Services and Ingresses, filters both the zone ID and
domain, and records ownership with a stack/stage/resource-specific TXT owner ID.
It exclusively owns the A/AAAA/CNAME records it derives and their registry TXT
records. Do not declare the same records with `Cloudflare.DNS.Record`.
cert-manager separately owns `_acme-challenge` TXT records.

With `policy: "sync"`, remove an application's Service/Ingress DNS declaration
and wait for reconciliation before destroying ExternalDNS; then its owned
records are removed. Destroying the controller itself deliberately performs no
zone-wide sweep, so records left behind require explicit cleanup. Use
`upsert-only` when record deletion is not authorized.

## Parseable

`Parseable` composes a Namespace, write-only Secret, pinned upstream Helm chart,
readiness gate, and optional Ingress. Permanent telemetry lives in the supplied
`S3BucketAccess`; the local PVC is only the durable staging queue:

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

Omit `ingress` for the safer ClusterIP-only default. The add-on does not install
an ingress controller, manage DNS, or issue the referenced TLS Secret. The
bundled OSS UI and the ingestion/query APIs use the same service, so an Ingress
exposes all of them.

The flat `otel*Endpoint` outputs match standard OTEL environment-variable names.
`endpoints` implements the endpoint portion of `Alchemy.Telemetry.OtlpOptions`
and includes the non-secret `X-P-Stream` and `X-P-Log-Source` headers. Streams
default to `otel-logs`, `otel-traces`, and `otel-metrics` and can be renamed
with `streams`. `credentialsSecretRef` lets an in-cluster collector mount the
Parseable Basic credentials without putting them in Helm values. Temporary S3
session credentials are rejected because the pinned Parseable chart does not
support them.

## OpenTelemetry collector gateway

`OtelCollector` is a destination adapter for any `Kubernetes.ClusterLike`. It
accepts the endpoint shape from `Alchemy.Telemetry.OtlpOptions`, adds optional
Basic authentication from a namespaced Secret, and exposes Axiom-shaped
in-cluster OTLP/HTTP endpoints:

```ts
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

When authentication is configured, the collector runs in the Secret's namespace
because Kubernetes cannot reference Secrets across namespaces. It adopts that
namespace instead of claiming ownership. Destination headers are stored in a
collector-owned Secret; the Helm values and generated ConfigMap contain only
environment-variable placeholders. Secret resource versions are copied to pod
annotations so a credential update rolls the Deployment.

Applications send unauthenticated OTLP/HTTP to the ClusterIP-only gateway:

```ts
vars: {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.otelTracesEndpoint,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.otelLogsEndpoint,
}
```

The first release deliberately enables only port 4318 and only destination
pipelines that were configured. It does not expose Ingress, OTLP/gRPC, host log
collection, Kubernetes event collection, or cluster-wide scraping; those need
different trust and RBAC boundaries.
