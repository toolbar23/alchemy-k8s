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
