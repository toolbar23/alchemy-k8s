# Complete Hetzner platform example

This stack composes the cluster kernel with independent DNS, TLS, S3-backed
observability, an optional S3-backed image registry, OTLP transport, and
application resources. It deliberately uses Let's Encrypt staging until an
operator changes the issuer environment after a successful smoke test.

Required configuration:

- `HCLOUD_TOKEN` or Hetzner credentials configured with `alchemy login`
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
- `PUBLIC_DOMAIN`, `ACME_EMAIL`, and `ADMIN_CIDR`
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
  `S3_SECRET_ACCESS_KEY`
- `K3S_BACKUP_S3_ENDPOINT`, `K3S_BACKUP_S3_REGION`, `K3S_BACKUP_S3_BUCKET`,
  `K3S_BACKUP_S3_ACCESS_KEY_ID`, `K3S_BACKUP_S3_SECRET_ACCESS_KEY`, and a
  cluster-unique `K3S_BACKUP_PREFIX`
- `PARSEABLE_ADMIN_PASSWORD`

Optional configuration:

- `S3_FORCE_PATH_STYLE` defaults to `false`.
- `K3S_BACKUP_S3_FORCE_PATH_STYLE` defaults to `false`.
- `ENABLE_OTEL` defaults to `true`.
- `ENABLE_OBSERVABILITY_INGRESS` defaults to `false`.
- `ENABLE_REGISTRY` defaults to `false`. When enabled, also supply
  `REGISTRY_HOST`, `REGISTRY_S3_ENDPOINT`, `REGISTRY_S3_REGION`,
  `REGISTRY_S3_BUCKET`, `REGISTRY_S3_ACCESS_KEY_ID`, and
  `REGISTRY_S3_SECRET_ACCESS_KEY`.
- `REGISTRY_S3_FORCE_PATH_STYLE` defaults to `false`.

Bootstrap the encrypted Cloudflare state store once, preview, then deploy:

```sh
alchemy cloudflare bootstrap
alchemy plan examples/hetzner-platform/alchemy.run.ts --stage production
alchemy deploy examples/hetzner-platform/alchemy.run.ts --stage production
```

The Zone is explicitly adopted and retained. ExternalDNS owns application
A/AAAA/CNAME records and registry TXT records. cert-manager owns only temporary
`_acme-challenge` records and the generated TLS Secrets. Parseable owns its
S3-backed telemetry service, while the optional collector is the in-cluster
credential and transport boundary. The optional registry owns only its
Kubernetes resources and creates an `api/private-registry` pull Secret; its
bucket remains external and retained. Docker clients require a publicly trusted
certificate, so change the demonstrated ACME issuer to production (after the
staging proof) before using the registry outside the cluster.

The K3s backup bucket is deliberately not declared by this stack. Create it in a
separate retained infrastructure stack, enable provider-side encryption and
versioning there, and issue credentials limited to that one bucket/prefix. A
cluster destroy therefore cannot delete its recovery root. The Cloudflare state
store encrypts the original K3s token and S3 credentials, but it does not expose
a cross-process deployment lock; use the locked Postgres state backend plus
`recovery` when enabling automatic control-plane replacement.

K3s metrics-server is unrelated to this telemetry stack. It keeps a short window
of CPU and memory resource metrics for `kubectl top` and autoscaling; it is not
a durable metrics database, OTLP receiver, log store, trace store, or dashboard
backend.
