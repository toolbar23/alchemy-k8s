# Manual Hetzner K3s E2E suite

This suite provisions paid Hetzner resources and is deliberately excluded from
the normal `npm test` path. Every cloud command requires an explicit profile:

- `single-x86`: one schedulable CX23 control plane in Nuremberg;
- `worker-x86`: one CX23 control plane and one CX23 worker in Nuremberg;
- `small-x86`: one CX23 control plane in Nuremberg and three CX23 workers across
  Nuremberg, Falkenstein, and Helsinki;
- `ha-x86`: three CX23 control planes and three CX23 workers across Nuremberg,
  Falkenstein, and Helsinki.

The stack starts on K3s `v1.35` so the ordered full run can exercise a real
minor upgrade to `v1.36`. The upgrade is last because the suite never attempts
to downgrade a cluster.

## Environment

Put `HETZNER_API_KEY` or `HCLOUD_TOKEN` in the repository `.env`. If both are
present they must match. The harness maps `HETZNER_API_KEY` to the name expected
by Alchemy without logging or persisting the token.

By default the current public IPv4 is detected and allowed as `/32` for SSH and
direct API fallback. Set `HETZNER_E2E_ALLOWED_CIDRS` to a comma-separated list
when using stable CI, office, or VPN egress.

## Commands

Run the complete ordered suite:

```sh
npm run e2e:hetzner:all -- --profile worker-x86
```

The command displays a live price estimate and requires typing the selected
profile. `--yes` is available for an already-reviewed non-interactive run.
Successful completion leaves the upgraded cluster running and protected.

Each phase can also be invoked separately with the same required `--profile`:

```sh
npm run e2e:hetzner:preflight -- --profile worker-x86
npm run e2e:hetzner:create -- --profile worker-x86
npm run e2e:hetzner:checks -- --profile worker-x86
npm run e2e:hetzner:benchmark -- --profile worker-x86
npm run e2e:hetzner:idempotence -- --profile worker-x86
npm run e2e:hetzner:scale -- --profile worker-x86
npm run e2e:hetzner:replace -- --profile worker-x86
npm run e2e:hetzner:upgrade -- --profile worker-x86
npm run e2e:hetzner:protection -- --profile worker-x86
```

Scale and replacement reject `single-x86`. The aggregate runner records those
phases as not applicable for that profile.

Worker replacement uses `WorkerPool.replacementToken`, so both generations use
the profile's existing server type. The workspace carries a version-pinned patch
for Alchemy `2.0.0-beta.74` because Hetzner server deletion actions can outlast
that release's roughly 30-second action waiter. `npm install` reapplies the
patch and allows compute actions up to roughly five minutes; remove it when the
equivalent upstream fix is available.

Functional and benchmark workloads are direct Kubernetes fixtures in an ignored,
run-scoped namespace. This intentionally tests the `Kubernetes.ClusterLike`
boundary returned by the Hetzner provider without conflating failures with
Alchemy's separate Kubernetes resource provider. The fixtures and any CSI
volumes are deleted after each phase.

Reports are written beneath `test-results/hetzner/<run-id>/`. The active,
resumable phase ledger and kubeconfig remain under ignored `.alchemy/` paths.

## Explicit teardown

Teardown is never part of the full runner:

```sh
npm run e2e:hetzner:destroy -- --profile worker-x86
```

It removes suite-owned Kubernetes workloads, exact recorded CSI volume and
Traefik load-balancer IDs, disables Alchemy deletion protection, destroys the
cluster, and verifies that no recorded resources remain before clearing the
active ledger.
