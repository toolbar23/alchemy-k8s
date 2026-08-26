# alchemy-s3-access

A provider-neutral contract for passing scoped S3-compatible bucket access
between Alchemy packages.

```ts
const access: S3BucketAccess = {
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "cluster-backups",
  accessKeyId: "scoped-access-key",
  secretAccessKey: Redacted.make(secret),
};
```

The producing provider owns bucket lifecycle and issues a separate scoped
credential per consumer. Consumers own prefixes and retention policy. This
package owns neither and has no AWS, Cloudflare, Fly, Prisma, Hetzner, or
Kubernetes dependency.

Temporary credentials can include a Redacted `sessionToken`; MinIO and similar
services can set `forcePathStyle`.
