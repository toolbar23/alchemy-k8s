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
