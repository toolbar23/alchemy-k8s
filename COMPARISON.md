# Comparison with `vitobotta/hetzner-k3s`

Snapshot date: **2026-08-26**

Compared projects:

- This workspace: [`alchemy-hetzner-k3s`](./packages/hetzner)
- Upstream reference:
  [`vitobotta/hetzner-k3s`](https://github.com/vitobotta/hetzner-k3s)
- Upstream source snapshot:
  [`4e293f47861aaf88bc4993b84b4687775c5277cf`](https://github.com/vitobotta/hetzner-k3s/commit/4e293f47861aaf88bc4993b84b4687775c5277cf)
- Upstream release inspected: `v2.6.0`

The implementation roadmap derived from this report is tracked in
[`TODO.md`](./TODO.md).

## Executive summary

`vitobotta/hetzner-k3s` is a broad cluster-management CLI. It supports more
operating systems, architectures, networking modes, CNIs, external nodes,
autoscaling, component toggles, and customization hooks.

`alchemy-hetzner-k3s` intentionally implements a narrower, opinionated cluster
kernel. Its strongest differences are declarative resource ownership, safe
worker replacement, strict public node firewall rules, automatic patch windows,
deletion protection, isolated kubeconfig output, and direct composition with
Alchemy's generic Kubernetes resources.

The local provider should not yet be promoted for high-value clusters. Phase 8
closed the SSH host-identity, sshd-baseline, recovery implementation, and core
hardening gaps; the largest remaining gates are live single/HA restore proof and
full upgrade/protection E2E coverage. OTEL, ExternalDNS, cert-manager, and Let's
Encrypt remain deliberately composable add-ons outside the core cluster
resource.

The target is not feature parity with the upstream CLI. The target is a smaller
surface with safer declarative lifecycle behavior and separate composable
add-ons.

## Research method

The comparison used:

- `gh repo view` for repository metadata.
- `gh issue list --state all` and individual issue inspection.
- `gh pr list --state all` and individual pull-request inspection.
- The upstream repository at the commit recorded above.
- Direct implementation comparison of provisioning, firewall, SSH, upgrade,
  replacement, Secret, kubeconfig, and release code.
- Local unit, lint, type, build, package, audit, and live E2E results.

Upstream history at the snapshot date:

| Item                           | Count |
| ------------------------------ | ----: |
| Stars                          | 3,667 |
| Forks                          |   231 |
| Issues                         |   457 |
| Open issues                    |    26 |
| Closed issues                  |   431 |
| Pull requests                  |   168 |
| Open pull requests             |     8 |
| Merged pull requests           |   123 |
| Closed, unmerged pull requests |    37 |

The upstream project has years of real-world issue history. Its failure reports
are useful even when the local implementation uses a different architecture.

## Feature comparison

| Area                       | `alchemy-hetzner-k3s`                                                                                                     | `vitobotta/hetzner-k3s`                                                                           | Gap or decision                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Provisioning model         | Declarative Alchemy resources and dependency graph                                                                        | Imperative CLI with YAML configuration                                                            | Different model by design                                         |
| Lifecycle operations       | Alchemy create/read/update/delete and drift-driven reconciliation                                                         | Separate create, run, upgrade, and delete commands                                                | Local model is narrower but more composable                       |
| Control plane              | Exactly 1 or 3 servers                                                                                                    | Flexible multi-master configuration                                                               | Opinionated local constraint                                      |
| Static workers             | Named pools with labels, taints, count, location, server type, and replacement token                                      | Static pools with broader node options                                                            | Core parity for ordinary pools                                    |
| Declarative worker removal | Supported                                                                                                                 | Missing; tracked upstream in [#773](https://github.com/vitobotta/hetzner-k3s/issues/773)          | Local advantage                                                   |
| Worker replacement         | Create first, wait Ready, drain, then delete                                                                              | Maintenance workflow with historical replacement failures                                         | Local advantage, E2E verified                                     |
| Control-plane replacement  | Explicit S3 restore policy, resumable single/HA reconstruction; live proof remains gated                                  | Master maintenance and replacement operations                                                     | Local implementation is safer; production proof pending           |
| Autoscaling                | Not supported                                                                                                             | Cluster Autoscaler integration                                                                    | Intentionally deferred                                            |
| External nodes             | Not supported                                                                                                             | Generic SSH and Hetzner Robot nodes                                                               | Intentionally deferred                                            |
| CPU architectures          | x86 server types in tested profiles                                                                                       | x86 and ARM                                                                                       | Upstream broader                                                  |
| Operating systems          | Ubuntu 24.04 only                                                                                                         | Multiple images, snapshots, and OS choices                                                        | Opinionated local constraint                                      |
| Network                    | Dedicated Hetzner private network                                                                                         | New or existing Hetzner network                                                                   | Upstream more flexible                                            |
| Public node interfaces     | Outbound IPv4 retained; IPv6 disabled; all public node ingress can be closed                                              | Public interfaces can be disabled                                                                 | Upstream supports NIC-less mode; local avoids hidden NAT need     |
| Private SSH                | Supported when the deploy runner routes to the Hetzner network                                                            | Supported                                                                                         | Broad parity for management traffic                               |
| API endpoint               | Mandatory public Hetzner Load Balancer                                                                                    | Load balancer optional; direct master access supported                                            | Opinionated local choice                                          |
| Private API load balancer  | Not supported                                                                                                             | Open work in [PR #791](https://github.com/vitobotta/hetzner-k3s/pull/791)                         | Missing in both released versions                                 |
| API allowlist              | Node firewall restricts TCP 6443 to explicit CIDRs, but the public load balancer itself cannot receive a Hetzner firewall | Firewall sources are configurable but commonly default open                                       | Local direct-node posture is stronger; public LB remains exposed  |
| SSH allowlist              | Explicit CIDRs, with current-IP lookup and validation                                                                     | Configurable, commonly defaults to all IPv4/IPv6                                                  | Local safer default                                               |
| NodePort exposure          | No public NodePort range                                                                                                  | TCP and UDP NodePorts enabled by default; can now be disabled                                     | Local safer default                                               |
| Custom firewall rules      | Opinionated fixed rules only                                                                                              | Supported                                                                                         | Upstream broader; local avoids a policy DSL                       |
| Host firewall              | None                                                                                                                      | Optional local firewall                                                                           | Local gap, but upstream implementation has a token-handling issue |
| CNI                        | Flannel VXLAN or `wireguard-native`                                                                                       | Flannel or Cilium                                                                                 | Upstream broader; local covers encrypted Flannel                  |
| Network encryption         | Opt-in Flannel `wireguard-native`                                                                                         | Supported                                                                                         | Broad parity for Flannel                                          |
| Cilium egress              | Not supported                                                                                                             | Supported                                                                                         | Intentionally deferred with Cilium                                |
| External datastore         | Embedded SQLite/etcd according to topology                                                                                | etcd, PostgreSQL, and MySQL options                                                               | Upstream broader                                                  |
| Embedded etcd snapshots    | Scheduled, retained, optional S3-compatible replication                                                                   | Supported, including S3                                                                           | Broad parity                                                      |
| Restore                    | First-class validated/resumable implementation and destructive harness; live proof pending                                | No complete first-class restore flow; [#659](https://github.com/vitobotta/hetzner-k3s/issues/659) | Local implementation advantage; proof gate remains                |
| HCCM                       | Installed and version-pinned                                                                                              | Optional installation                                                                             | Local is opinionated                                              |
| CSI                        | Installed and version-pinned                                                                                              | Optional installation                                                                             | Local is opinionated                                              |
| System Upgrade Controller  | Installed and version-pinned                                                                                              | Optional installation                                                                             | Local is opinionated                                              |
| Patch upgrades             | Two rolling plans, maintenance window, control planes before workers                                                      | Upgrade command and SUC integration                                                               | Local automation is simpler but needs complete live validation    |
| Minor upgrades             | Explicit channel change with downgrade/skipped-minor rejection                                                            | Explicit upgrade workflow                                                                         | Both require operator intent                                      |
| Traefik and ServiceLB      | K3s defaults retained                                                                                                     | Configurable toggles                                                                              | Upstream more flexible                                            |
| metrics-server             | K3s default retained                                                                                                      | Configurable toggle                                                                               | Upstream more flexible                                            |
| Registry mirrors           | Not exposed                                                                                                               | Supported                                                                                         | Deferred                                                          |
| Private registries         | Not exposed                                                                                                               | Supported                                                                                         | Deferred                                                          |
| Package installation       | Fixed bootstrap only                                                                                                      | Custom packages supported                                                                         | Deliberately omitted                                              |
| Bootstrap hooks            | No arbitrary hooks                                                                                                        | Supported                                                                                         | Deliberately omitted                                              |
| Component arguments        | Fixed opinionated arguments                                                                                               | Broad component argument customization                                                            | Deliberately omitted                                              |
| API hostname               | Load-balancer endpoint and generated kubeconfig contexts                                                                  | Custom API hostname supported                                                                     | Upstream broader                                                  |
| Placement groups           | Control-plane placement is managed internally                                                                             | Configurable placement groups                                                                     | Upstream broader                                                  |
| Large-cluster tuning       | No explicit large-cluster profile                                                                                         | Supported                                                                                         | Deferred until measured                                           |
| SSH keys                   | Per-server Ed25519 deploy keys generated by Alchemy                                                                       | Shared generated or existing SSH key                                                              | Local reduces shared-key scope                                    |
| Kubeconfig                 | Written under `.alchemy/kubeconfigs/hetzner`, mode `0600`, without mutating the user's default config                     | Written mode `0600`; historical merge behavior was fixed                                          | Local ownership is cleaner                                        |
| Deletion protection        | Enabled by default and must be explicitly disabled before destroy                                                         | CLI confirmation/lifecycle controls                                                               | Local stronger declarative guard                                  |
| Resource ownership         | Exact Alchemy resources with provider IDs and deletion graph                                                              | CLI labels/config-derived cleanup                                                                 | Local advantage                                                   |
| Kubernetes composition     | Implements `Kubernetes.ClusterLike`                                                                                       | Produces kubeconfig for ordinary tooling                                                          | Local advantage inside Alchemy                                    |
| ExternalDNS                | Zone-scoped Cloudflare add-on with Secret-backed token and TXT ownership                                                  | Not a core capability                                                                             | Separate add-on by design                                         |
| cert-manager/Let's Encrypt | Pinned generic cert-manager plus exact-zone Cloudflare DNS-01 issuer add-ons                                              | Not a core capability                                                                             | Separate add-ons by design                                        |
| OTEL/Parseable             | S3-backed Parseable and ClusterIP-only OTLP/HTTP collector add-ons implemented                                            | Not a core capability                                                                             | Separate add-ons by design                                        |

## Security-critical comparison

### Summary matrix

| Control                              | `alchemy-hetzner-k3s`                                                                        | `vitobotta/hetzner-k3s`                                                                                             | Assessment                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SSH server host verification         | Deterministic Ed25519 host key installed out of band; strict one-host known-hosts file       | Disabled in the SSH client                                                                                          | Local closes the interception gap                                            |
| SSH client key scope                 | Unique Alchemy-generated Ed25519 key per server                                              | Shared generated or existing key                                                                                    | Local is narrower                                                            |
| SSH password authentication          | Explicitly disabled                                                                          | Explicitly disabled                                                                                                 | Good in both                                                                 |
| Root SSH                             | `PermitRootLogin prohibit-password`; forwarding and tunnels disabled                         | `PermitRootLogin prohibit-password`                                                                                 | Local is at least as explicit                                                |
| SSH source CIDRs                     | Required explicit sources                                                                    | Defaults commonly open                                                                                              | Local safer default                                                          |
| Kubernetes API source CIDRs          | Direct masters restricted; mandatory public LB remains reachable                             | Configurable but commonly open                                                                                      | Local partial improvement                                                    |
| Public NodePorts                     | Closed                                                                                       | Open by default, optional disable                                                                                   | Local safer default                                                          |
| Public node interfaces               | Outbound-only IPv4 retained; public inbound can be closed                                    | Can be disabled                                                                                                     | Different NAT tradeoff, both support private management                      |
| Private management path              | Supported for routed deploy runners                                                          | Private SSH/network modes available                                                                                 | Broad parity                                                                 |
| Node host firewall                   | None                                                                                         | Optional                                                                                                            | Local gap                                                                    |
| Host-firewall credential handling    | Not applicable                                                                               | Full Hetzner token is embedded in a mode-`0755` script; [#716](https://github.com/vitobotta/hetzner-k3s/issues/716) | Upstream security issue avoided locally                                      |
| CNI encryption                       | Flannel `wireguard-native`                                                                   | Supported                                                                                                           | Broad parity for Flannel                                                     |
| Kubernetes Secret encryption at rest | Enabled by default with `secretbox` where supported; guarded migration for existing clusters | Not built in by default                                                                                             | Local advantage; live migration evidence still required                      |
| Volume encryption                    | Not supported                                                                                | Not supported; [#607](https://github.com/vitobotta/hetzner-k3s/issues/607)                                          | Gap in both; do not claim encrypted volumes                                  |
| API audit logging                    | Enabled by default with bounded metadata-log rotation                                        | Not a default hardening feature                                                                                     | Local advantage                                                              |
| CIS profile                          | Not enabled                                                                                  | Not a default hardening feature                                                                                     | Gap in both                                                                  |
| Pod Security admission policy        | Not configured                                                                               | Not a default hardening feature                                                                                     | Gap in both                                                                  |
| gVisor                               | Not supported                                                                                | Open [PR #771](https://github.com/vitobotta/hetzner-k3s/pull/771)                                                   | Missing in released versions                                                 |
| Cloud provider token                 | Stored in HCCM and CSI Secrets and Redacted Alchemy state                                    | Stored in cluster configuration/Secrets                                                                             | Same unavoidable runtime privilege; state and etcd must be encrypted         |
| Token rotation                       | Secret changes restart/wait HCCM and CSI; K3s Secret keys rotate dynamically on token change | Historical credential/config drift reports                                                                          | Local implementation advantage                                               |
| Kubeconfig permissions               | `0600`                                                                                       | `0600`                                                                                                              | Good in both                                                                 |
| Deletion blast radius                | Exact owned resources plus default deletion protection                                       | Historical project-deletion bug, later fixed                                                                        | Local architecture safer                                                     |
| Remote install integrity             | Commit-pinned installer is SHA-256 checked; it verifies the exact K3s release binary         | Release binaries/workflows lack a complete checksum/signature/SBOM chain                                            | Local materially stronger; signatures/SBOM still future work                 |
| CI dependency pinning                | GitHub Actions pinned to commit SHAs                                                         | Third-party Actions pinned by tags                                                                                  | Local advantage                                                              |
| Release provenance                   | npm OIDC provenance                                                                          | Release workflow without complete checksums, signatures, or SBOM                                                    | Local npm publication is stronger, but source Actions still need SHA pinning |

### SSH bootstrap

The local provider derives an Ed25519 host identity from an Alchemy Redacted
random, installs it through first-boot cloud-init, and accepts only that key.
The key is known before the first SSH connection, so this is not trust on first
use. The upstream client still disables host verification.

The upstream project has improved server-side sshd policy through
[#595](https://github.com/vitobotta/hetzner-k3s/issues/595) and
[#736](https://github.com/vitobotta/hetzner-k3s/issues/736): password,
keyboard-interactive, and challenge-response authentication are disabled, and
root login is limited to public keys. The local provider now applies the same
baseline plus disabled forwarding and tunnels, validates it with `sshd -t`, and
restarts sshd before bootstrap.

Tests prove the generated OpenSSH key is accepted by `ssh-keygen` and the client
uses `StrictHostKeyChecking=yes` without a null known-hosts file.

### Cloud-init and bootstrap completion

The local provider now waits for `cloud-init status --wait` and requires a final
`done` status. Upstream added a similar explicit wait in
[PR #380](https://github.com/vitobotta/hetzner-k3s/pull/380).

The K3s path owns the full MIME user-data document, so Alchemy's unrelated Bun
bootstrap does not run. Its K3s installer is commit-pinned and hash-checked.

### Network perimeter

The local Hetzner firewall is intentionally small:

- TCP 22 from explicit management CIDRs.
- ICMP.
- TCP 6443 from explicit Kubernetes API CIDRs.
- No public NodePort range.

Upstream defaults have historically allowed SSH, the Kubernetes API, and TCP and
UDP NodePorts broadly. It now supports custom firewall rules and disabling
NodePort exposure, but operators must opt into the tighter policy.

The local mandatory public API Load Balancer remains accessible because Hetzner
firewalls cannot attach to load balancers. Kubernetes TLS and client
certificates still authenticate requests, but a private load balancer or VPN
management path would reduce exposure and denial-of-service surface.

### Cluster network and storage encryption

The local cluster uses Flannel VXLAN over the Hetzner private network. The
traffic is private but not cryptographically protected against an attacker with
access to that network. Upstream supports encrypted networking.

Neither implementation currently gives a complete volume-encryption guarantee.
Kubernetes Secret encryption and CNI encryption must not be described as disk
volume encryption; they solve different threats.

### Cloud tokens and Kubernetes Secrets

HCCM and CSI require a Hetzner project token. The local provider correctly
stores it as an Effect `Redacted` value in Alchemy state and as Kubernetes
Secrets at runtime. New clusters enable K3s encryption at rest by default.
Existing unencrypted clusters, and encrypted clusters moving from `aescbc` to
`secretbox`, require the explicit snapshot-guarded migration option.

Parseable, the OTEL collector, and ExternalDNS propagate non-secret Secret
resource versions into pod-template annotations so credential changes cause
deterministic rollouts. The Cloudflare ACME issuer instead gives each rotated
credential a distinct Secret and ClusterIssuer identity, then makes downstream
Certificate inputs wait for the replacement issuer to become ready.

The implemented add-ons use the Redacted-safe `KubernetesAddons.Secret` against
Alchemy's public cluster-adapter API. Values are unwrapped only at the API
request boundary and Secret data is never read back into state. ExternalDNS's
runtime token has only `Zone Read`, `DNS Read`, and `DNS Write` on the exact
zone; Helm receives only a Secret reference. Its Kubernetes service account has
cluster-wide read-only access for the enabled Service and Ingress sources. The
ACME issuer mints a separate exact-zone token with only `Zone Read` and
`DNS Write`; it does not reuse ExternalDNS's broader credential unless the
caller explicitly supplies one. cert-manager generates ACME account and issued
certificate private keys inside Kubernetes, and neither Secret is returned to
Alchemy state. The pinned chart runs controller, webhook, and CA injector as
non-root containers with read-only root filesystems, dropped capabilities, and
the runtime-default seccomp profile. Redacted desired inputs are still persisted
by Alchemy, so production deployments require encrypted remote state.

### Supply chain

The local implementation pins HCCM, CSI, and System Upgrade Controller version
tags, which prevents accidental version drift, but it does not verify manifest
content hashes. K3s installation uses the upstream shell installer with an exact
requested patch rather than a pinned installer body or verified binary.

The production target is:

- Vendor or content-hash remote manifests.
- Pin or vendor the K3s installer, or download a verified release binary.
- Remove the unnecessary Bun installation from K3s servers.
- Pin GitHub Actions to full commit SHAs.
- Preserve npm OIDC provenance.
- Publish checksums and an SBOM where artifacts are distributed.

## Implementation comparison of shared concerns

### Resource ownership and deletion

Alchemy owns every Hetzner network, firewall, server, load balancer, SSH key,
and cluster-state resource independently. It deletes resources by exact provider
identity and protects cluster destruction by default. This architecture avoids
the class of broad project deletion reported in upstream
[#15](https://github.com/vitobotta/hetzner-k3s/issues/15).

Upstream cleanup is necessarily reconstructed by the CLI from its configuration
and labels. It is more flexible, but historical issues show that broad cleanup
logic needs substantial defensive code.

### Worker replacement

The local provider gives each server a unique ID-derived Kubernetes node name.
For a worker replacement it:

1. Creates the new server.
2. Waits for SSH and Kubernetes Ready.
3. Drains the old node.
4. Deletes the old server.

If readiness fails, both servers remain and the deployment fails safely. This
addresses the duplicate-hostname class in
[#390](https://github.com/vitobotta/hetzner-k3s/issues/390) and the failed
replacement class in
[#650](https://github.com/vitobotta/hetzner-k3s/issues/650).

The local provider still refuses an unconfigured initial-control-plane
replacement, avoiding the destructive outcome in
[#311](https://github.com/vitobotta/hetzner-k3s/issues/311). With explicit
recovery policy, retained S3 access, original encrypted identity, and locked
state, it restores a new host and reconstructs workers/HA membership. Routine
rotation remains a release gate until the destructive live restore passes.

### Upgrade implementation

The local provider installs one System Upgrade Controller and creates two plans:

- Control planes first, concurrency one.
- Workers second, concurrency one.
- Cordon before upgrade.
- Required maintenance days, time window, and IANA time zone.
- Explicit minor channel with skipped-minor and downgrade rejection.

The control-plane selector uses the single correct K3s role label. This is
simpler than several selector/concurrency regressions discussed in upstream
[#750](https://github.com/vitobotta/hetzner-k3s/issues/750),
[#756](https://github.com/vitobotta/hetzner-k3s/issues/756), and
[#769](https://github.com/vitobotta/hetzner-k3s/issues/769).

However, the latest local E2E upgrade phase did not pass, so the design is not
yet fully validated.

### Kubeconfig handling

The local provider writes a dedicated mode-`0600` kubeconfig under
`.alchemy/kubeconfigs/hetzner`. It includes a load-balancer context and direct
contexts for every control-plane server, selects the load-balancer context, and
does not mutate `~/.kube/config`.

This avoids the permission issue in
[#20](https://github.com/vitobotta/hetzner-k3s/issues/20) and the destructive
merge behavior in [#107](https://github.com/vitobotta/hetzner-k3s/issues/107).

### Timeouts and failure behavior

The local provider bounds current-IP lookup, SSH connection, node readiness,
remote commands, and Hetzner action waits. This addresses the general class of
indefinite waits reported in upstream
[#184](https://github.com/vitobotta/hetzner-k3s/issues/184),
[#320](https://github.com/vitobotta/hetzner-k3s/issues/320),
[#509](https://github.com/vitobotta/hetzner-k3s/issues/509), and
[#522](https://github.com/vitobotta/hetzner-k3s/issues/522).

Failure injection is still incomplete, so the timeout design is stronger than
the current evidence.

## Upstream issue mapping

Status meanings:

- **Solved:** the local design and tests cover the issue class.
- **Partial:** some protection exists, but an important path is missing or
  unverified.
- **Missing:** the local provider has no solution.
- **Fail-safe:** the unsafe action is refused instead of implemented.
- **N/A:** the feature that caused the issue is deliberately absent.

| Upstream issue                                                                                                                                                                                                                                     | Theme                                            | Local status                 | Local analysis                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| [#15](https://github.com/vitobotta/hetzner-k3s/issues/15)                                                                                                                                                                                          | Destructive project deletion                     | Solved                       | Exact Alchemy ownership and default deletion protection avoid broad project cleanup      |
| [#20](https://github.com/vitobotta/hetzner-k3s/issues/20)                                                                                                                                                                                          | Kubeconfig file permissions                      | Solved                       | Generated file is mode `0600`                                                            |
| [#76](https://github.com/vitobotta/hetzner-k3s/issues/76)                                                                                                                                                                                          | Kubernetes API allowlist                         | Partial                      | Direct masters are restricted; mandatory public load balancer remains reachable          |
| [#107](https://github.com/vitobotta/hetzner-k3s/issues/107)                                                                                                                                                                                        | Overwriting the user's kubeconfig                | Solved                       | Dedicated Alchemy kubeconfig; no mutation of `~/.kube/config`                            |
| [#184](https://github.com/vitobotta/hetzner-k3s/issues/184), [#320](https://github.com/vitobotta/hetzner-k3s/issues/320), [#509](https://github.com/vitobotta/hetzner-k3s/issues/509), [#522](https://github.com/vitobotta/hetzner-k3s/issues/522) | Commands or provisioning hang indefinitely       | Solved for implemented paths | Waits are bounded and every recovery checkpoint has failure injection                    |
| [#311](https://github.com/vitobotta/hetzner-k3s/issues/311)                                                                                                                                                                                        | Recreating the first master destroys the cluster | Implemented, proof pending   | Unconfigured replacement is refused; explicit validated restore prevents empty bootstrap |
| [#390](https://github.com/vitobotta/hetzner-k3s/issues/390)                                                                                                                                                                                        | Duplicate hostname during replacement            | Solved                       | Every server receives a unique ID-derived node name                                      |
| [#474](https://github.com/vitobotta/hetzner-k3s/issues/474)                                                                                                                                                                                        | Firewall/NodePort exposure                       | Solved for default surface   | NodePorts are not opened publicly                                                        |
| [#595](https://github.com/vitobotta/hetzner-k3s/issues/595), [#736](https://github.com/vitobotta/hetzner-k3s/issues/736)                                                                                                                           | sshd hardening                                   | Solved                       | Explicit drop-in disables password auth, forwarding, and tunnels                         |
| [#598](https://github.com/vitobotta/hetzner-k3s/issues/598)                                                                                                                                                                                        | Custom SSH port handling                         | N/A                          | Local provider does not expose custom SSH ports                                          |
| [#607](https://github.com/vitobotta/hetzner-k3s/issues/607)                                                                                                                                                                                        | Volume encryption                                | Missing                      | No local volume-encryption implementation                                                |
| [#629](https://github.com/vitobotta/hetzner-k3s/issues/629)                                                                                                                                                                                        | SSH available before cloud-init completes        | Solved                       | Strict-key SSH is followed by bounded cloud-init completion/status validation            |
| [#650](https://github.com/vitobotta/hetzner-k3s/issues/650)                                                                                                                                                                                        | Worker replacement failure                       | Solved for tested path       | Create-first replacement and live E2E passed                                             |
| [#652](https://github.com/vitobotta/hetzner-k3s/issues/652)                                                                                                                                                                                        | Cloud token rotation                             | Implemented                  | Secret changes explicitly restart and wait for HCCM/CSI                                  |
| [#659](https://github.com/vitobotta/hetzner-k3s/issues/659)                                                                                                                                                                                        | Cluster restore                                  | Implemented, proof pending   | First-class single/HA path and destructive E2E harness; live run still required          |
| [#678](https://github.com/vitobotta/hetzner-k3s/issues/678)                                                                                                                                                                                        | Master server-type rotation                      | Missing by design            | Control-plane topology is immutable until recovery is proven                             |
| [#701](https://github.com/vitobotta/hetzner-k3s/issues/701)                                                                                                                                                                                        | Mutable autoscaler manifest                      | N/A/Partial class            | Autoscaler is absent; local remote manifests are version-tagged but not content-hashed   |
| [#707](https://github.com/vitobotta/hetzner-k3s/issues/707)                                                                                                                                                                                        | Conflicting token sources/precedence             | Solved structurally          | One ambient Alchemy Hetzner credential; no cluster token property                        |
| [#716](https://github.com/vitobotta/hetzner-k3s/issues/716)                                                                                                                                                                                        | Hetzner token embedded in host firewall script   | Exact issue avoided          | No host firewall script; tokens still exist in Kubernetes Secrets and Alchemy state      |
| [#750](https://github.com/vitobotta/hetzner-k3s/issues/750), [#756](https://github.com/vitobotta/hetzner-k3s/issues/756), [#769](https://github.com/vitobotta/hetzner-k3s/issues/769)                                                              | Upgrade selectors, ordering, or concurrency      | Partial                      | Local plans are simpler, but full live upgrade validation is incomplete                  |
| [#753](https://github.com/vitobotta/hetzner-k3s/issues/753), [#754](https://github.com/vitobotta/hetzner-k3s/issues/754), [#765](https://github.com/vitobotta/hetzner-k3s/issues/765)                                                              | Autoscaler drift and SSH-key behavior            | N/A                          | Autoscaling is intentionally absent                                                      |
| [#773](https://github.com/vitobotta/hetzner-k3s/issues/773)                                                                                                                                                                                        | Declarative static worker-pool removal           | Solved                       | Local scale-down E2E passed                                                              |

## Pull-request history signals

The following upstream pull requests show which areas repeatedly required
correctness or security work:

| Pull request                                                                                                         | Change                                       | Relevance to this provider                                                        |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| [#244](https://github.com/vitobotta/hetzner-k3s/pull/244)                                                            | Disable public network interfaces            | Supports the case for private-only local nodes                                    |
| [#380](https://github.com/vitobotta/hetzner-k3s/pull/380)                                                            | Wait for cloud-init                          | Implemented locally with bounded final-status validation                          |
| [#391](https://github.com/vitobotta/hetzner-k3s/pull/391)                                                            | Custom SSH port fix                          | N/A until local custom ports exist                                                |
| [#394](https://github.com/vitobotta/hetzner-k3s/pull/394)                                                            | General wait/retry behavior                  | Reinforces bounded, observable readiness waits                                    |
| [#536](https://github.com/vitobotta/hetzner-k3s/pull/536)                                                            | UDP NodePort firewall rules                  | Local avoids the entire public NodePort surface                                   |
| [#590](https://github.com/vitobotta/hetzner-k3s/pull/590)                                                            | Cilium egress support                        | Deferred with Cilium                                                              |
| [#602](https://github.com/vitobotta/hetzner-k3s/pull/602)                                                            | Network-encryption error handling            | Local exposes only K3s' native validated `wireguard-native` selector              |
| [#623](https://github.com/vitobotta/hetzner-k3s/pull/623)                                                            | Optional component toggles                   | Local core intentionally remains opinionated                                      |
| [#633](https://github.com/vitobotta/hetzner-k3s/pull/633)                                                            | S3 etcd snapshots                            | Portable S3 contract and validated restore are implemented locally                |
| [#643](https://github.com/vitobotta/hetzner-k3s/pull/643)                                                            | SSH key fingerprint validation               | Validates the configured public key; it does not authenticate the server host key |
| [#647](https://github.com/vitobotta/hetzner-k3s/pull/647)                                                            | Custom firewall rules                        | Local avoids a generic firewall policy surface for now                            |
| [#672](https://github.com/vitobotta/hetzner-k3s/pull/672)                                                            | Hetzner API pagination                       | Any future enumeration must test pagination                                       |
| [#702](https://github.com/vitobotta/hetzner-k3s/pull/702)                                                            | Reliability, local firewall, and concurrency | Confirms these are operational hot spots                                          |
| [#727](https://github.com/vitobotta/hetzner-k3s/pull/727)                                                            | Private-IP node creation                     | Private management is implemented; NIC-less nodes still need explicit NAT         |
| [#732](https://github.com/vitobotta/hetzner-k3s/pull/732)                                                            | Disable NodePort firewall exposure           | Local default already omits NodePorts                                             |
| [#766](https://github.com/vitobotta/hetzner-k3s/pull/766)                                                            | Existing SSH key support                     | Local deliberately uses per-server managed keys                                   |
| [#768](https://github.com/vitobotta/hetzner-k3s/pull/768), [#787](https://github.com/vitobotta/hetzner-k3s/pull/787) | Tailscale support                            | Possible future private-management option; not yet required                       |
| [#771](https://github.com/vitobotta/hetzner-k3s/pull/771)                                                            | gVisor support                               | Deferred sandboxing feature                                                       |
| [#780](https://github.com/vitobotta/hetzner-k3s/pull/780)                                                            | External nodes                               | Deliberately outside local v1 scope                                               |
| [#781](https://github.com/vitobotta/hetzner-k3s/pull/781)                                                            | Cilium validation                            | Any local Cilium support would need a substantial validation matrix               |
| [#785](https://github.com/vitobotta/hetzner-k3s/pull/785)                                                            | External routing                             | Deferred advanced networking                                                      |
| [#791](https://github.com/vitobotta/hetzner-k3s/pull/791)                                                            | Private API load balancer                    | Directly relevant to the local private-management roadmap                         |

## Local verification state

### Automated checks

`npm run release:check` passed after the Phase 8 implementation. It covered:

- TypeScript type checking.
- ESLint and Prettier.
- 81 tests across 17 files.
- Package builds.
- Package-content checks.
- Production dependency audit with zero vulnerabilities.
- Rendering every pinned add-on chart image.

The current main CI run was passing:
[GitHub Actions run](https://github.com/toolbar23/alchemy-k3s/actions/runs/32931545312).

The local CI is broader than the inspected upstream workflow: it runs audit and
the full check command, while the upstream workflow primarily compiles release
binaries. The local npm release uses OIDC provenance, and its checkout, Node,
and Helm Actions are now pinned to full commit SHAs.

### Live Hetzner E2E

The manual suite has single-x86, worker-x86, and ha-x86 profiles.

Latest worker report inspected:

[`test-results/hetzner/2026-08-26T05-20-15.089Z-worker-x86/report.md`](./test-results/hetzner/2026-08-26T05-20-15.089Z-worker-x86/report.md)

Passed phases:

- Cluster creation.
- Kubernetes DNS and outbound network checks.
- Ingress.
- CSI-backed persistence.
- Benchmarking.
- Idempotent re-apply.
- Worker scale-up and scale-down.
- Same-size worker replacement.

Failed phase:

- Kubernetes upgrade.

Failure log:

[`test-results/hetzner/2026-08-26T05-20-15.089Z-worker-x86/upgrade.log`](./test-results/hetzner/2026-08-26T05-20-15.089Z-worker-x86/upgrade.log)

The failure was caused by deriving a nonexistent HCCM `v1.36.0` release from the
K3s minor channel. The current working implementation pins HCCM `v1.35.0`
independently and includes a regression test. `npm run check` passes with that
fix, but the complete live upgrade and protection phases have not been rerun.

That historical report did not preserve the upgrade failure clearly enough. The
current harness records the failed phase and message in both its JSON and
Markdown reports; the live upgrade rerun is still outstanding.

## Gap register

### Phase 8 implementation update (2026-08-26)

The previous code gaps are now implemented without changing Alchemy core:

| Previous gap                                                    | Current implementation                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH trusted the first network response                          | Alchemy-derived Ed25519 host identity is installed by cloud-init; every SSH call uses strict `known_hosts` verification                                        |
| No explicit sshd baseline or cloud-init barrier                 | Password/challenge auth, forwarding, tunnels, and empty passwords are disabled; bootstrap waits for successful cloud-init                                      |
| Mutable remote K3s installer                                    | The installer URL is commit-pinned and SHA-256 checked; the exact K3s binary remains release-checksummed                                                       |
| Hetzner-only S3 backup shape                                    | `S3BucketAccess` now supplies access ID, Redacted secret, optional session token, endpoint, region, and path-style behavior                                    |
| Restore depended on a live K3s API                              | A deploy-runner SigV4 client lists/HEADs S3 objects and validates K3s cluster ID, original-token hash, size, and age before restore                            |
| Initial control-plane replacement could become an empty cluster | Persisted initial identity is retained even when the host is unreachable; replacement is refused unless explicit recovery policy and a valid S3 snapshot exist |
| No resumable single/HA recovery                                 | K3s restore checkpoints resume safely; HA peers discard stale membership and rejoin, workers change bootstrap address, and the old Node is deleted last        |
| Concurrent recovery was undefined                               | Recovery requires Alchemy's advisory-locked Postgres state backend and an explicit provider-side encryption assertion                                          |
| S3/Cloudflare state was treated as sufficient for recovery      | It remains suitable for encrypted ordinary state, but automatic recovery refuses it because it has no cross-process deployment lease                           |
| Token rotation did not roll HCCM/CSI                            | A changed Hetzner token reapplies Secrets, restarts both controllers, and waits for rollouts                                                                   |
| Secret encryption had migration but no routine rotation         | `secretsEncryption.keyRotationToken` invokes K3s v1.35+ dynamic `rotate-keys` and verifies secretbox/hash convergence                                          |
| No private management mode                                      | Alchemy can SSH only over the private network while public node ingress is closed; IPv4 remains outbound-only unless a future NAT topology removes it          |
| No encrypted pod transport option                               | `wireguard-native` is an explicit Flannel option shared by Hetzner and local definitions                                                                       |
| No API audit trail                                              | Metadata audit logging is enabled by default with bounded local rotation                                                                                       |
| Mutable GitHub Action tags                                      | Checkout, Node setup, and Helm setup are pinned to commit SHAs                                                                                                 |

The destructive recovery harness exists for `small-x86` and `ha-x86` and records
snapshot age, detection, replacement, API, worker, RTO, and observable RPO
timings. Live single/HA restore remains a release proof gate until it is run
with the separately retained S3 bucket and encrypted locked state; this report
does not promote implemented test code into unearned production evidence.

### P0: before recommending production use

1. Run the new Secret-encryption and interrupted-migration checks against live
   single-server and HA clusters.
2. Complete single, worker, and HA upgrade/protection/cleanup E2E.
3. Record every failed E2E phase and error in machine and human reports.
4. Prove single-node and HA S3 snapshot restore with the implemented destructive
   harness.

### P1: security and operational hardening

1. Add a private API load-balancer option when Hetzner support is usable.
2. Add a public-NIC-less NAT/VPN topology if outbound-only IPv4 is unacceptable.
3. Decide whether a node host firewall adds material protection beyond the
   Hetzner firewall without placing cloud credentials on disk.
4. Add an explicit Pod Security admission baseline for user workloads.
5. Assess a CIS profile against K3s compatibility and document deviations.
6. Promote control-plane rotation only after live restore proof passes.

### P2: composable platform services

Phase 0 completed the Redacted-safe `KubernetesAddons.Secret` primitive and the
`ReadyHelmChart` composition without modifying Alchemy core. Parseable, the
cluster-agnostic OTLP/HTTP collector gateway, zone-scoped Cloudflare
ExternalDNS, generic cert-manager, and a Cloudflare DNS-01 issuer are
implemented. The remaining platform-service tasks are:

1. E2E-test the implemented S3-backed Parseable add-on and its bundled UI.
2. E2E-test collector signal routing and credential rotation on Docker and
   Hetzner K3s.
3. E2E-test Parseable and collector destruction boundaries.
4. Add a reusable application example with Deployment, Service, Ingress, and
   Certificate ownership together.
5. Run the documented one-hostname Let's Encrypt production smoke test before a
   production release.

Detailed checklists and sequencing are in [`TODO.md`](./TODO.md).

## Explicit non-goals and deferred choices

The following upstream capabilities should not be copied merely for parity:

- Autoscaling before static-pool operations are fully reliable.
- Cilium before a concrete network-policy or eBPF requirement.
- Arbitrary operating-system images.
- Generic bootstrap hooks and package installation.
- External datastore support.
- External/Robot nodes.
- Custom SSH ports.
- A generic firewall rule DSL.
- A generic add-on registry.
- A generic DNS-provider interface before a second implementation exists.
- Grafana, Loki, Tempo, or Mimir before Parseable has a measured feature or
  scaling limitation.

Volume encryption, gVisor, CIS hardening, and Pod Security should remain visible
security gaps even when deferred. Documentation must not imply that private
networking, Secret encryption, or CSI persistence provides volume encryption.

## Architectural conclusion

Keep the cluster kernel responsible for:

- Hetzner network, firewall, load balancer, servers, and lifecycle.
- K3s, CoreDNS, HCCM, CSI, and System Upgrade Controller.
- Upgrades, snapshots, recovery hooks, and cluster security invariants.

Keep higher-level services separate and accept `Kubernetes.ClusterLike`:

- Parseable and other OTLP destinations.
- OTEL collectors and later telemetry agents.
- ExternalDNS.
- cert-manager and provider-specific ACME issuers.
- Application ingress and Certificate manifests.

Alchemy already supplies the composition primitives needed for this boundary:
`Kubernetes.ClusterLike`, `Kubernetes.HelmChart`, `Kubernetes.Manifest`, and
`Telemetry.OtlpOptions`. `alchemy-kubernetes-addons` adds safe Secret handling
and reusable workload readiness through Alchemy's public adapter seam. Phase 0
needs no Alchemy patch; the repository retains only its unrelated, pre-existing
Hetzner action-poll timeout adjustment. No generic plug-in framework or new OTEL
abstraction is needed.
