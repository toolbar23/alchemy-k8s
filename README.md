# Alchemy K3s extensions

Two experimental Alchemy providers that make self-managed K3s clusters look like
`AWS.EKS.Cluster` to Alchemy's Kubernetes resources:

- [`alchemy-hetzner-k3s`](packages/hetzner): Hetzner Cloud servers, private
  networking, firewall, public API load balancer, HCCM, CSI, and unattended K3s
  patch updates.
- [`alchemy-docker-k3s`](packages/docker): a persistent single-node local K3s
  cluster managed through k3d.

Both return an object with a `connection` attribute and can be passed directly
to `Kubernetes.Deployment`, `Job`, `Manifest`, or `HelmChart`. These packages
are alpha software: test recovery and upgrades before using the Hetzner provider
for important workloads.

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
npm install
npm run check
```

The packages are versioned together. GitHub Actions validates every pull request
and push. Publishing is triggered by a GitHub Release whose tag exactly matches
the workspace version (for example `v0.1.0-alpha.0`). The release workflow uses
npm trusted publishing/OIDC and provenance.

Because npm's trusted publisher is configured from an existing package's
settings, the first release needs a one-time granular automation token in the
GitHub repository secret `NPM_TOKEN`. Give it a short expiry and the minimum
publish access npm permits for new packages, publish the first release,
configure both trusted publishers, and then delete the secret. Subsequent
releases need no npm token.

Prerelease versions are published under npm's `next` tag; stable versions use
`latest`.

Before the first release, configure each package on npmjs.com with this trusted
publisher:

- organization/user: `toolbar23`
- repository: `alchemy-k3s`
- workflow: `publish.yml`
- allowed action: `npm publish`

Package names are independently checked for existence before publishing, so a
workflow retry can finish a partially completed two-package release.
