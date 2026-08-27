# Alchemy K3s extensions

Five experimental Alchemy extensions for self-managed K3s and composable
Kubernetes services:

- [`alchemy-hetzner-k3s`](packages/hetzner): Hetzner Cloud servers, private
  networking, firewall, public API load balancer, HCCM, CSI, and unattended K3s
  patch updates.
- [`alchemy-docker-k3s`](packages/docker): a persistent single-node local K3s
  cluster managed through k3d.
- [`alchemy-kubernetes-native`](packages/kubernetes-api): generated typed
  Kubernetes built-ins with drift detection, adoption, safe deletion, readiness,
  YAML, and rendered Helm composition.
- [`alchemy-kubernetes-addons`](packages/kubernetes-addons): Redacted-safe
  Kubernetes Secrets, bounded Helm workload readiness, Cloudflare ExternalDNS,
  cert-manager/Let's Encrypt, and S3-backed Parseable/OTLP observability
  add-ons.
- [`alchemy-s3-access`](packages/s3-access): the provider-neutral, Redacted
  credential contract used to pass scoped S3-compatible bucket access.

Both cluster providers return an object with a `connection` attribute and can be
passed directly to `Kubernetes.Deployment`, `Job`, `Manifest`, or `HelmChart`,
or to the typed resources in `alchemy-kubernetes-native`. These packages are
alpha software: test recovery and upgrades before using the Hetzner provider for
important workloads.

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
replacements still converge one node at a time. A machine replacement is
delete-first because its stable Hetzner name is the external transaction
identity; the obsolete Kubernetes Node is retained until the replacement is
Ready and is then removed idempotently.

Nodes receive public IPv4 for outbound internet and public IPv6 is disabled. By
default deployment SSH is CIDR-restricted on that IPv4. With
`ssh.privateOnly: true`, all node ingress is closed and Alchemy resolves and
uses the private address; the runner must already route to the Hetzner network
through a VPN or private runner. The public NIC remains only for outbound K3s
and image downloads, avoiding a hidden NAT-gateway requirement.

Every server receives a deterministic Ed25519 host key whose seed is Redacted in
Alchemy state. Cloud-init installs that key and a hardened sshd drop-in; Alchemy
waits for cloud-init and uses a one-host `known_hosts` file with strict
checking. K3s uses a commit-pinned installer whose SHA-256 is verified before
execution; the installer in turn verifies the exact resolved K3s binary.

### Crash convergence and state boundaries

`alchemy-hetzner-k3s` does not treat the end of an Alchemy provider callback as
its only transaction boundary. Alchemy state records desired graph progress,
while recoverable physical facts record sub-operation progress:

- Every machine has a required stable Hetzner name, exact Alchemy ownership
  labels, and a declared generation label.
- The per-machine deploy SSH key exists as its own Alchemy/Hetzner resource
  before server creation. Server reconciliation creates no hidden credential.
- Every rerun observes the server by persisted ID and then stable name before it
  mutates anything. Network, firewall, metadata, protection, deletion, and
  create-response races are re-observed and checked against exact invariants.
- Create-only changes use delete-first replacement because two servers cannot
  own the same stable name. A missing physical server is replacement, even if
  Alchemy state still says that a prior replacement completed.
- K3s install and Kubernetes publication are repeatable. HA peer rejoin,
  snapshot restore, and Secret-encryption migration use host-side checkpoints
  only where several external commands form one logical transaction. A
  checkpoint is never accepted without re-observing its physical postcondition.
- K3s receives the canonical Hetzner provider ID as a kubelet argument. Node
  reconciliation waits through registration `NotFound` responses until the Node
  is Ready; it does not race registration with a redundant API patch.

The intended invariant is: terminating a deployment after any accepted external
action and rerunning it converges without duplicate servers, leaked deploy keys,
or manual edits to Alchemy state.

This is implemented without an Alchemy core patch. The machine resource owns its
Hetzner action polling, observation, and retry policy; an Alchemy callback
timeout merely causes the next deployment to re-observe the same external
identity.

This lifecycle is deliberately greenfield. There is no compatibility or adoption
path from the former `Hetzner.Server`-backed cluster state. Destroy clusters
created by `alchemy-hetzner-k3s` 0.1.0-alpha.4 or earlier before deploying this
version. Do not point the new provider at those existing server names; strict
generation ownership will refuse them.

Set `k3s.flannelBackend: "wireguard-native"` for encrypted pod transport. API
audit logging is enabled by default with bounded local rotation and can be tuned
through `apiAuditLog`. Production-like stage names now fail early unless the
state backend is known encrypted or `state.encryptionAtRestConfirmed` is set.
Hetzner credential changes re-apply Secrets and deterministically restart both
HCCM and CSI.

### Upgrades and recovery

The minor is pinned in code (`v1.35` in the example). Initial provisioning
resolves that channel to an exact K3s patch from the K3s channel service's
redirect metadata without following the redirect to GitHub. Resolution has
bounded retry/backoff. The Hetzner cluster installs the pinned System Upgrade
Controller version and two rolling plans:

- one control-plane server at a time;
- then one worker at a time;
- only in the required IANA-time-zone maintenance window.

This runs unattended even when Alchemy is not running. A one-control-plane
cluster has a brief API outage during an update. Three control planes retain API
availability. Changing the minor requires changing `channel` in code; skipped
automatic minors and downgrades are rejected.

Embedded etcd snapshots run hourly with retention 24 by default. S3 replication
uses the provider-neutral `S3BucketAccess` contract from `alchemy-s3-access`:

```ts
etcdSnapshots: {
  schedule: "0 * * * *",
  retention: 24,
  folder: "clusters/production",
  s3: {
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    bucket: "retained-k3s-backups",
    accessKeyId,
    secretAccessKey,
    sessionToken, // optional
    forcePathStyle: false,
  },
}
```

When bundled Traefik is enabled, the initial server installs a durable K3s
`HelmChartConfig` before K3s starts. Its LoadBalancer Service suppresses private
ingress publication while HCCM continues to route to node targets over the
private network. This prevents ExternalDNS from publishing the cluster-private
address beside the public load-balancer address.

The bucket must be created in a separate retained stack with encryption,
versioning, and bucket-scoped credentials. K3s receives session-token and
path-style settings for scheduled save/prune and restore. Recovery lists and
HEADs objects directly with SigV4, without a Kubernetes API or S3 credential
Secret, then rejects empty, expired, foreign-cluster, or wrong-token objects.
K3s performs the download and embedded-etcd checksum verification.

Automatic initial-control-plane recovery is explicit and is invoked by an
external monitor or scheduled CI deployment; Alchemy is not a resident
controller:

```ts
state: { encryptionAtRestConfirmed: true },
recovery: {
  restoreOnInitialControlPlaneReplacement: true,
  maximumSnapshotAge: 15 * 60,
  // Set/change only to test a deliberate machine replacement.
  replacementToken: "2026-08-drill-1",
},
```

This mode requires Alchemy's Postgres state backend because it holds and checks
a cross-process advisory lease. The database must use TLS and provider-side
encryption, acknowledged by `state.encryptionAtRestConfirmed`; local, in-memory,
unlocked HTTP/Cloudflare, and S3 state are refused for automatic recovery. The
original Redacted server token and kube-system UID are kept in state and matched
against K3s' S3 object metadata. If the initial physical server disappears, the
next deployment creates one host, restores the newest valid snapshot with the
original token, waits for etcd/API/Secret-encryption health, reconstructs HA
membership, reconnects workers, verifies the load balancer, and only then
removes the obsolete Kubernetes Node.

Recovery checkpoints in `/var/lib/rancher/k3s/.alchemy-recovery-phase` make the
sequence resumable and bind the transaction to the exact selected snapshot.
`recovery.failureInjection` accepts `after-server-creation`,
`after-snapshot-selection`, `after-snapshot-download`, `after-etcd-reset`,
`after-normal-start`, and `after-state-persistence`. On invalid metadata or
checksum failure the replacement and backup are retained; an empty cluster is
never bootstrapped under the old identity. Compressed restores require K3s
v1.35.3 or newer due to
[GHSA-jxr7-mqhw-9p98](https://github.com/k3s-io/k3s/security/advisories/GHSA-jxr7-mqhw-9p98).

The destructive recovery harness records snapshot age, detection delay,
replacement/restore time, API recovery, worker reconnection, total RTO, and an
observable RPO. It supports `small-x86` and `ha-x86`:

```sh
npm run e2e:hetzner:disaster-recovery -- --profile small-x86
```

It requires `HETZNER_E2E_STATE_DATABASE_URL`,
`HETZNER_E2E_STATE_ENCRYPTED=true`, and the documented `HETZNER_E2E_S3_*`
variables. A successful run destroys exactly the cluster resources and retains
the unique backup prefix.

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
  // Change this later to perform one dynamic K3s v1.35+ key rotation.
  keyRotationToken: "2026-08";
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
- Worker counts and worker server types are mutable. The old machine is removed
  first because the replacement owns the same stable Hetzner name. The old
  Kubernetes Node remains until the new node is Ready; its final drain/delete is
  safe to repeat.
- Ubuntu 24.04 is the only node OS in v1. OS upgrades, autoscaling, arbitrary
  bootstrap hooks, public-NIC-less nodes without an explicit NAT topology, and
  custom SSH ports are out of scope.
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
storage encryption. Hetzner, K3s, SSH, backup, Cloudflare, and Parseable
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

### Cloudflare ExternalDNS

DNS ownership is an optional add-on rather than part of either cluster provider.
Create or explicitly adopt the retained Cloudflare zone, then attach the
zone-scoped controller:

```ts
import * as Cloudflare from "alchemy/Cloudflare";
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

Register `Cloudflare.providers()` alongside the Kubernetes and add-on providers.
The deployment credential comes from `alchemy login` or `CLOUDFLARE_ACCOUNT_ID`
plus `CLOUDFLARE_API_TOKEN`. To mint the default runtime token it needs
account-scoped `Account API Tokens Write` and `Zone Read` for an existing zone;
creating the zone also needs `Zone Write`.

The generated runtime token grants only `Zone Read`, `DNS Read`, and `DNS Write`
for the exact zone. Its value crosses into Kubernetes through the write-only
Secret resource; Helm sees only a Secret reference. ExternalDNS filters the
exact zone ID and domain, watches only Services and Ingresses, and uses a stable
TXT registry owner derived from stack, stage, and logical resource identity.

ExternalDNS exclusively owns its dynamic A/AAAA/CNAME and registry TXT records.
Do not also create those records with `Cloudflare.DNS.Record`; cert-manager owns
`_acme-challenge` records. Under `sync`, delete application DNS declarations and
wait for reconciliation before destroying the controller. Controller destruction
intentionally does not sweep the zone, and the zone itself remains retained.
Registrar nameserver delegation is external.

### cert-manager and Let's Encrypt

TLS is another optional layer. Install cert-manager once, then create a
provider-specific issuer for the retained zone:

```ts
const certManager =
  yield * KubernetesAddons.CertManager("Certificates", { cluster });

const issuer =
  yield *
  KubernetesAddons.CloudflareAcmeIssuer("LetsEncrypt", {
    cluster,
    certManager,
    zone,
    email: "platform@example.com",
    environment: "staging",
  });

yield *
  Kubernetes.Manifest("ApiCertificate", {
    cluster,
    manifest: {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "api-tls", namespace: "api" },
      spec: {
        secretName: "api-tls",
        dnsNames: ["api.example.com"],
        issuerRef: issuer.issuerRef,
      },
    },
  });
```

The add-on pins the upstream OCI chart, owns its CRDs, waits for controller,
webhook, CA injector, and `ClusterIssuer` readiness, and scopes the generated
Cloudflare token to exact-zone `Zone Read` plus `DNS Write`. Its token is
separate from ExternalDNS's token by default, which keeps rotation and
revocation independent. Passing one pre-created Redacted token to both add-ons
intentionally couples their permissions and availability.

Each application owns its requested domains, Certificate manifest, TLS Secret
name, and Ingress/Gateway reference. cert-manager generates the private key in
Kubernetes and owns the temporary `_acme-challenge` TXT record; issued private
keys never enter Alchemy state. Start with `environment: "staging"`. A
production smoke test should be an explicit, one-hostname manual deployment so
it cannot accidentally consume production rate limits; verify the non-staging
chain, then remove the Certificate and issuer and confirm the challenge record
and token disappear while the Zone remains.

### Parseable observability

`Parseable` installs the pinned OSS standalone chart with its bundled web UI,
keeps committed telemetry in a supplied `S3BucketAccess`, and retains a small
persistent staging volume for acknowledged data that has not reached S3 yet. It
creates the namespace and write-only Secret before Helm, and uses the Secret's
resource version as a non-secret pod annotation so credential rotation rolls the
StatefulSet:

```ts
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
```

Ingress is absent by default and expects an existing controller and optional TLS
Secret. ExternalDNS owns the DNS record and cert-manager owns that Secret.
Because the UI and APIs share one service, enabling public Ingress exposes both;
prefer private access or an authentication proxy.

The result exposes `otelEndpoint`, `otelTracesEndpoint`, `otelLogsEndpoint`, and
`otelMetricsEndpoint` for Axiom-shaped composition. Parseable OSS authenticates
these endpoints with its admin Basic credentials, so applications should send to
the in-cluster OTEL collector; do not distribute `parseable.admin.password` to
workloads:

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

const appTelemetry = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.otelTracesEndpoint,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: collector.otelLogsEndpoint,
};
```

The collector exposes only unauthenticated OTLP/HTTP on its ClusterIP Service.
It injects Parseable's signal headers and Basic credentials at the destination
boundary. Header values and credentials stay in Kubernetes Secrets; Helm values
and the collector ConfigMap contain only environment references. OTLP/gRPC,
Ingress, host log collection, Kubernetes events, and cluster scraping are not
enabled.

The topology and defaults are informed by
[`vitobotta/hetzner-k3s`](https://github.com/vitobotta/hetzner-k3s): private
networking, CCM/CSI, embedded etcd, unschedulable masters, firewall allowlists,
per-server deploy keys, load-balanced API access, and explicit maintenance
behavior. This provider intentionally differs where Alchemy's resource graph
provides safer lifecycle behavior: it always creates an API load balancer, does
not expose NodePorts, and reconciles machine replacement directly instead of
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
npm run release:check
```

The release check runs type, lint, unit, build, package-content, dependency
audit, and pinned Helm-render checks.

The typed Kubernetes provider has a separate current/previous-minor k3d matrix:

```sh
mise run e2e:kubernetes-native
```

It adopts pre-created objects, proves no-op planning and drift repair, replaces
an immutable StatefulSet, applies a CRD plus generic custom resource, and
verifies exact teardown.

A reusable live smoke stack exercises the write-only Secret and OTLP gateway
against either local k3d or Hetzner K3s:

```sh
ADDONS_E2E_KUBECONFIG=/path/to/kubeconfig \
ADDONS_E2E_TARGET=docker \
ADDONS_E2E_SECRET="$(openssl rand -hex 32)" \
alchemy deploy scripts/addons-e2e.run.mjs --stage docker --yes
```

Run the same deploy again to check idempotence, change only `ADDONS_E2E_SECRET`
to check Secret rotation and collector rollout, then run `alchemy destroy` with
the same file and stage. Use a fresh random value and do not echo it; the value
is intentionally absent from stack output and plans.

Set `ADDONS_E2E_REMOTE_STATE=true` to run the same lifecycle against the
encrypted Cloudflare state store created by `alchemy cloudflare bootstrap`.

The S3-backed registry has a separate, manually triggered lifecycle with
independent preflight, deployment, functional, benchmark, rotation, persistence,
and teardown phases. It deploys the registry through the public add-on API,
pushes through its HTTPS Ingress, proves a K3s node pull, measures scheduled GC
against S3, and recreates the add-on without deleting its images:

```sh
npm run e2e:registry:all
```

See [`scripts/registry-e2e/README.md`](scripts/registry-e2e/README.md) for the
required Kubernetes, TLS, and `S3BucketAccess` environment. The complete suite
is destructive only to its two stage-specific Kubernetes namespaces. The
provider-owned bucket and its registry objects are deliberately retained.

The live Cloudflare security gate creates a temporary exact-zone token with only
`Zone Read`, proves that DNS writes receive HTTP 403, and always attempts exact
record and token cleanup while preserving every cleanup error:

```sh
npm run e2e:cloudflare:permissions -- /path/to/cloudflare.env
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
Bootstrap every unpublished workspace interactively from a trusted workstation
using npm 2FA:

```sh
mise install
mise exec -- just release-dry-run
mise exec -- just release
```

`just release` delegates to the repository's guarded `mise run publish` task. It
verifies the npm login, installs from the lockfile, runs the complete check
suite, and publishes every public workspace that does not exist on npm. With
mise activated in the shell, the shorter `just release` command is equivalent.
Already-published versions are skipped. If a package already exists but the
workspace contains a new version, the task stops and directs that release to
GitHub OIDC instead. Provenance is disabled only for a package's one-time local
bootstrap because npm provenance requires a supported CI environment.

Prerelease versions are published under npm's `next` tag; stable versions use
`latest`.

After the bootstrap, configure each package on npmjs.com with this trusted
publisher:

- organization/user: `toolbar23`
- repository: `alchemy-k8s`
- workflow: `publish.yml`
- environment: `npm`
- allowed action: `npm publish`

Then set each package's publishing access to **Require two-factor authentication
and disallow tokens**. Future releases need no `NPM_TOKEN` secret. Increment the
synchronized workspace version, finish the JJ revision, and leave a new empty
working-copy revision. This task runs the complete dry-run, fast-forwards and
pushes `main` to the completed parent revision, then creates the exact
`v<version>` GitHub Release that triggers OIDC publishing:

```sh
mise run publish:oidc
```

The first OIDC release after the bootstrap must use a version newer than the
already-published bootstrap version.

Package names are independently checked for existence before publishing, so a
workflow retry can finish a partially completed multi-package release.
