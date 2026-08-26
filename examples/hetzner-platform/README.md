# Complete Hetzner platform example

This stack composes the cluster kernel with independent DNS, TLS, S3-backed
observability, OTLP transport, and application resources. It deliberately uses
Let's Encrypt staging until an operator changes the issuer environment after a
successful smoke test.

Required configuration:

- `HCLOUD_TOKEN` or Hetzner credentials configured with `alchemy login`
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
- `PUBLIC_DOMAIN`, `ACME_EMAIL`, and `ADMIN_CIDR`
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
  `S3_SECRET_ACCESS_KEY`
- `PARSEABLE_ADMIN_PASSWORD`

Optional configuration:

- `S3_FORCE_PATH_STYLE` defaults to `false`.
- `ENABLE_OTEL` defaults to `true`.
- `ENABLE_OBSERVABILITY_INGRESS` defaults to `false`.

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
credential and transport boundary.

K3s metrics-server is unrelated to this telemetry stack. It keeps a short
window of CPU and memory resource metrics for `kubectl top` and autoscaling; it
is not a durable metrics database, OTLP receiver, log store, trace store, or
dashboard backend.
