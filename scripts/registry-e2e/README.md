# Container registry manual E2E

This suite deploys `KubernetesAddons.ContainerRegistry` against an existing
Kubernetes cluster and S3-compatible bucket. It never applies registry YAML
directly. The Alchemy fixture stack owns the two test namespaces, TLS Secret,
registry add-on, pull Secret, and pull-test Deployment; the bucket and its
contents remain external.

Required tools are `mise`, `kubectl`, `skopeo`, `curl`, and `openssl`. Supply a
certificate for `REGISTRY_E2E_HOST`; DNS must already route that host to the
cluster's ingress controller. A public CA is simplest. With a private CA, set
`REGISTRY_E2E_TLS_VERIFY=false` for the external checks and separately install
the CA in every K3s/containerd node trust store so the pull-test Deployment can
verify it.

```sh
export REGISTRY_E2E_STAGE=manual
export REGISTRY_E2E_KUBECONFIG=/path/to/kubeconfig
export REGISTRY_E2E_HOST=registry-test.example.com
export REGISTRY_E2E_USERNAME=registry-e2e
export REGISTRY_E2E_PASSWORD="$(openssl rand -hex 24)"
export REGISTRY_E2E_TLS_CERT_FILE=/path/to/fullchain.pem
export REGISTRY_E2E_TLS_KEY_FILE=/path/to/privkey.pem

export REGISTRY_E2E_S3_ENDPOINT=https://s3.example.com
export REGISTRY_E2E_S3_REGION=eu-central-1
export REGISTRY_E2E_S3_BUCKET=registry-e2e
export REGISTRY_E2E_S3_ACCESS_KEY_ID=...
export REGISTRY_E2E_S3_SECRET_ACCESS_KEY=...
export REGISTRY_E2E_S3_FORCE_PATH_STYLE=false
```

Temporary credentials may additionally set `REGISTRY_E2E_S3_SESSION_TOKEN`. Set
`REGISTRY_E2E_CONTEXT` when the kubeconfig contains more than one context. The
supplied S3 identity needs the Zot push/pull and garbage-collection permissions
documented by upstream: bucket list/location/multipart-list plus object
get/put/delete/multipart operations under `registry-e2e/$REGISTRY_E2E_STAGE`.

Run phases independently while diagnosing a retained deployment:

```sh
npm run e2e:registry:preflight
npm run e2e:registry:deploy
npm run e2e:registry:checks
npm run e2e:registry:benchmark
npm run e2e:registry:idempotence
npm run e2e:registry:persistence
npm run e2e:registry:destroy
```

Or run the complete destructive lifecycle:

```sh
npm run e2e:registry:all
```

The complete run verifies unauthenticated rejection, authenticated external
push/pull, a K3s node pull using the generated namespace-local Secret, pod
restart recovery, scheduled garbage collection, no-op stability, credential
rotation, and image survival across add-on destruction/recreation. Results are
written to `test-results/registry/<stage>/report.json`; credentials are never
written to that report. Final teardown deletes the Kubernetes fixtures but
intentionally leaves the S3 objects and bucket for the bucket owner.
