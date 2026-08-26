# Alchemy K3s extensions

Three experimental Alchemy extensions for self-managed K3s and composable
Kubernetes services:

- [`alchemy-hetzner-k3s`](packages/hetzner): Hetzner Cloud servers, private
  networking, firewall, public API load balancer, HCCM, CSI, and unattended K3s
  patch updates.
- [`alchemy-docker-k3s`](packages/docker): a persistent single-node local K3s
  cluster managed through k3d.
- [`alchemy-kubernetes-addons`](packages/kubernetes-addons): Redacted-safe
  Kubernetes Secrets and bounded Helm workload readiness, with DNS,
  certificates, and telemetry add-ons planned on top.

Both cluster providers return an object with a `connection` attribute and can be
passed directly to `Kubernetes.Deployment`, `Job`, `Manifest`, or `HelmChart`.
These packages are alpha software: test recovery and upgrades before using the
Hetzner provider for important workloads.

## Hetzner cluster

Install the provider alongside the Alchemy and Effect versions used by the
stack:

```sh
npm install alchemy-hetzner-k3s alchemy effect
```

Alchemy's Hetzner provider owns the API token. Configure it in the normal
Alchemy profile flow or with `HCLOUD_TOKEN`; there is deliberately no token
property on `Cluster`.

```ts
import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Kubernetes from "alchemy/Kubernetes";
import * as HetznerK3s from "alchemy-hetzner-k3s";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "app",
  {
    providers: Layer.mergeAll(
      Hetzner.providers(),
      Kubernetes.providers(),
      HetznerK3s.providers(),
    ),
    // Development only. Production must use an encrypted remote state store.
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* HetznerK3s.Cluster("production", {
      k3s: {
        channel: "v1.35",
        updateWindow: {
          days: ["Sunday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "Europe/Berlin",
        },
      },
      controlPlane: {
        count: 3,
        serverType: "cpx22",
        locations: ["nbg1", "fsn1", "hel1"],
      },
      workerPools: [
        { name: "general", serverType: "cpx32", location: "nbg1", count: 3 },
      ],
      ssh: { allowedCidrs: ["203.0.113.42/32"] },
    });

    const api = yield* Kubernetes.Deployment("Api", {
      cluster,
      image: "ghcr.io/example/api:sha-0123456789",
      port: 8080,
      replicas: 2,
      external: true,
    });

    return { api, endpoint: cluster.endpoint };
  }),
);
```

`external: true` creates an ordinary `LoadBalancer` Service. HCCM is configured
cluster-wide to put application load balancers in the cluster's network zone and
target nodes over their private addresses.

For one control-plane server, scheduling remains disabled there by default, so
at least one worker is required. Set `scheduleWorkloadsOnControlPlane: true`
only when the single-node tradeoff is intentional.

Initial provisioning waits for the first control-plane server to initialize the
cluster, then joins the remaining control-plane servers and workers in parallel.
Reconciliation of existing nodes remains serialized per cluster, so upgrades and
create-first replacements still roll one node at a time.

Nodes receive a public IPv4 address for direct deployment SSH and internet
egress, but public IPv6 is disabled. Kubernetes and load-balancer traffic
between nodes uses the private network.

### Upgrades and recovery

The minor is pinned in code (`v1.35` in the example). Initial provisioning
resolves that channel to an exact K3s patch. The Hetzner cluster installs the
pinned System Upgrade Controller version and two rolling plans:

- one control-plane server at a time;
- then one worker at a time;
- only in the required IANA-time-zone maintenance window.

This runs unattended even when Alchemy is not running. A one-control-plane
cluster has a brief API outage during an update. Three control planes retain API
availability. Changing the minor requires changing `channel` in code; skipped
automatic minors and downgrades are rejected.

Embedded etcd snapshots run hourly with retention 24 by default. Optional
S3-compatible replication accepts Effect `Redacted` access and secret keys. Use
an encrypted remote Alchemy state for production: state necessarily holds the
Alchemy-managed server deploy keys, K3s join token, and any backup credentials.

Kubernetes Secret encryption at rest is enabled on every new control-plane
server. K3s uses `secretbox` whenever the resolved patch supports it and the
provider verifies the status and cross-server hashes before returning the
cluster. The manual `single-x86` and `ha-x86` E2E profiles verify this on one
and three control planes respectively.

Existing unencrypted clusters, and encrypted clusters that still use `aescbc`,
require explicit consent because migration takes an etcd snapshot, restarts
every control plane, and re-encrypts all Secrets:

```ts
secretsEncryption: {
  migrateExisting: true;
}
```

The installed K3s version must meet the upstream migration gate:
`v1.33.10+k3s1`, `v1.34.6+k3s1`, `v1.35.3+k3s1`, or newer. The provider saves
and verifies a non-empty on-demand snapshot before enablement or provider
migration, records the migration mode and progress in
`/var/lib/rancher/k3s/server/db/.alchemy-secrets-encryption-migration`, restarts
control planes sequentially, refuses to rotate while hashes disagree, and
retains the snapshot after completion.

If a migration is interrupted, stop concurrent deploys and do not remove the
marker or snapshot. On every control plane, inspect
`k3s secrets-encrypt status`; do not manually advance a mismatched HA cluster.
Re-run the same Alchemy deployment: the marker lets it resume before rotation,
after rotation, or during final restarts. The optional
`secretsEncryption.failureInjection` checkpoints (`after-snapshot`,
`after-enable`, `after-control-plane-restarts`, `after-rotate`, and
`after-final-restarts`) test that recovery path. If status cannot be reconciled,
leave K3s stopped and restore the retained snapshot using the
[official K3s snapshot restore procedure](https://docs.k3s.io/cli/etcd-snapshot#restoring-snapshots)
before making another encryption change.

The generated kubeconfig is written mode `0600` beneath
`.alchemy/kubeconfigs/hetzner`. It contains contexts for the API load balancer
and every control-plane server, selects the load balancer, and is refreshed on
every read so a clean CI runner can reconstruct it.

### Safety and current limitations

- Destruction is protected by default. First deploy
  `protectAgainstDeletion: false`, then run destroy.
- Control-plane count, locations, server type, network CIDR, and Kubernetes
  CIDRs are immutable in v1. Create a replacement cluster to change them.
- Worker counts and worker server types are mutable. Replacements are
  create-first: a new node joins and becomes Ready before the old node is
  drained. A failed readiness check retains both servers and fails safely.
- Ubuntu 24.04 is the only node OS in v1. OS upgrades, autoscaling, arbitrary
  bootstrap hooks, private-only deploy runners, and custom SSH ports are out of
  scope.
- The Kubernetes API load balancer is always public. Hetzner firewalls cannot
  attach to load balancers; Kubernetes TLS and client certificates secure the
  API. NodePorts are not opened publicly.
- Application-created Hetzner load balancers, volumes, and snapshots are not
  swept when the cluster is deleted.

### Kubernetes Secrets and Helm readiness

Install `alchemy-kubernetes-addons` and add `KubernetesAddons.providers()` next
to `Kubernetes.providers()`. The package uses only Alchemy's public Kubernetes
adapter API; Phase 0 adds nothing to the Alchemy patch. The repository's
pre-existing patch only extends Hetzner action polling from 10 to 60 attempts.
Use the package's write-only `Secret` for credentials and `Kubernetes.Manifest`
only for public manifest data:

```ts
import * as KubernetesAddons from "alchemy-kubernetes-addons";

providers: Layer.mergeAll(
  Kubernetes.providers(),
  KubernetesAddons.providers(),
),
```

```ts
const credentials =
  yield *
  KubernetesAddons.Secret("CloudflareCredentials", {
    cluster,
    namespace: "external-dns",
    name: "cloudflare-api-token",
    stringData: { "api-token": token.value },
  });
```

Literal values become Effect `Redacted` immediately. Lazy Effect values resolve
directly to `Redacted`, while Config and Output values are mapped to `Redacted`
before provider diffing and state persistence. Values are unwrapped only in the
Kubernetes PATCH body. Reads return only connection, identity, type, UID, and
resource version—never Secret data. Alchemy still persists the Redacted input so
updates can be detected; Redacted hides values from plans and logs but is not
storage encryption. Hetzner, K3s, SSH, backup, Cloudflare, and Grafana
credentials are therefore necessarily state inputs as those features are
composed. Production must use an encrypted remote state backend. A
production-like stage using `local` or `inmemory` state emits a preflight
warning. This repository does not add its own state cryptography.

Never put a credential directly in Helm values; create a Secret first and pass
only the chart's Secret name/key reference. `ReadyHelmChart` delegates ownership
to Alchemy's existing `Kubernetes.HelmChart`, then waits for CRDs, Deployments,
DaemonSets, StatefulSets, and Jobs with a bounded deadline:

```ts
yield *
  KubernetesAddons.ReadyHelmChart("Controller", {
    cluster,
    chart: "controller",
    repo: "https://charts.example.com",
    version: "1.2.3",
    timeoutSeconds: 300,
    values: { existingSecret: credentials.name },
  });
```

Timeout and terminal-failure errors identify the object and sanitized conditions
without including manifests, Secret bodies, or environment values.

The topology and defaults are informed by
[`vitobotta/hetzner-k3s`](https://github.com/vitobotta/hetzner-k3s): private
networking, CCM/CSI, embedded etcd, unschedulable masters, firewall allowlists,
per-server deploy keys, load-balanced API access, and explicit maintenance
behavior. This provider intentionally differs where Alchemy's resource graph
provides safer lifecycle behavior: it always creates an API load balancer, does
not expose NodePorts, and performs create-first worker rolls instead of
requiring a separate maintenance command.

## Local cluster

Install [Docker](https://docs.docker.com/get-docker/) and
[k3d 5.9.x](https://k3d.io), then:

```sh
npm install alchemy-docker-k3s alchemy effect
```

```ts
import * as Alchemy from "alchemy";
import * as Docker from "alchemy/Docker";
import * as Kubernetes from "alchemy/Kubernetes";
import * as DockerK3s from "alchemy-docker-k3s";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "local-app",
  {
    providers: Layer.mergeAll(
      Docker.providers(),
      Kubernetes.providers(),
      DockerK3s.providers(),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* DockerK3s.Cluster("dev", {
      k3s: {
        channel: "v1.35",
        updateWindow: {
          days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
          startTime: "09:00",
          endTime: "18:00",
          timeZone: "Europe/Berlin",
        },
      },
      ports: [{ hostPort: 8080, containerPort: 80 }],
    });

    return yield* Kubernetes.Deployment("Api", {
      cluster,
      image: "example/api:dev",
      port: 80,
      external: true,
    });
  }),
);
```

The external Docker volume mounted at `/var/lib/rancher/k3s` preserves the
database, certificates, and local-path volumes across K3s patch updates. It is
owned by Alchemy and remains until the cluster resource itself is destroyed.

Local updates are checked only during `alchemy deploy`; there is no background
daemon. If a newer patch exists outside the window, deploy prints a warning and
leaves the running cluster untouched. Inside the window, k3d recreates its
containers with the exact new image and the same external volume. This is a
single-node cluster, so workloads and the API are temporarily unavailable. The
extension does not change the user's default kubeconfig or current context.

Ports for externally exposed Services must be declared when the cluster is
created. A Docker context is supported for plain and SSH Docker endpoints;
TLS-material-heavy remote contexts should be tested explicitly with k3d.

## A backend-independent deployment function

Application code only needs an Alchemy `Input<Kubernetes.ClusterLike>`, so the
same function can target EKS, Hetzner K3s, or local k3d. The `Input` wrapper is
important in a helper signature because a resource's `connection` is an Alchemy
output until the graph is applied:

```ts
const deployApp = (cluster: Alchemy.Input<Kubernetes.ClusterLike>) =>
  Effect.gen(function* () {
    return yield* Kubernetes.Deployment("Api", {
      cluster,
      image: "ghcr.io/example/api:sha-0123456789",
      port: 8080,
    });
  });
```

This compatibility covers Kubernetes workload resources and prebuilt images. It
does not emulate EKS image builds, registries, or workload identity.

## Development and releases

```sh
npm ci
npm run check
```

The repository pins npm 12 for local development, CI, and publishing. Dependency
install scripts are denied unless they are explicitly reviewed and added to the
root `allowScripts` policy.

The packages are versioned together. GitHub Actions validates every pull request
and push. After the packages have been bootstrapped, publishing is triggered by
a GitHub Release whose tag exactly matches the workspace version. The release
workflow uses npm trusted publishing/OIDC and provenance, with no npm token in
GitHub.

npm trusted publishers can only be configured for packages that already exist.
Bootstrap both package names interactively from a trusted workstation using npm
2FA:

```sh
npm ci
npm run check
npm publish ./packages/hetzner --access public --tag next --provenance=false
npm publish ./packages/docker --access public --tag next --provenance=false
```

The interactive commands prompt for 2FA. Provenance is disabled only for this
one-time local bootstrap because npm provenance requires a supported CI
environment.

Prerelease versions are published under npm's `next` tag; stable versions use
`latest`.

After the bootstrap, configure each package on npmjs.com with this trusted
publisher:

- organization/user: `toolbar23`
- repository: `alchemy-k3s`
- workflow: `publish.yml`
- allowed action: `npm publish`

Then set each package's publishing access to **Require two-factor authentication
and disallow tokens**. Future releases need no `NPM_TOKEN` secret. Increment the
synchronized workspace version, push it, and publish a GitHub Release with the
exact `v<version>` tag. The first OIDC release after the bootstrap should
therefore use a new version such as `0.1.0-alpha.1`, not the already-published
bootstrap version.

Package names are independently checked for existence before publishing, so a
workflow retry can finish a partially completed two-package release.
