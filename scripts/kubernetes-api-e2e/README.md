# Typed Kubernetes provider live gate

The matrix owns two explicitly named disposable k3d clusters, resolves exact
patch releases from the pinned `v1.36` and `v1.35` K3s channels, and always
deletes those clusters. It refuses to reuse a cluster with either target name.

```sh
mise run e2e:kubernetes-native
```

Set `KUBERNETES_API_E2E_CHANNELS=v1.37,v1.36` when the supported minor window
moves. The lifecycle pre-creates a Namespace and ConfigMap, adopts both, proves
a second no-op plan, repairs external drift, replaces a StatefulSet after an
immutable `serviceName` change, applies a typed CRD and generic custom resource,
then destroys everything and verifies namespace absence. Reports are written
under ignored `test-results/kubernetes-api/`.

To run the same lifecycle against an existing cluster instead:

```sh
KUBERNETES_API_E2E_KUBECONFIG=/path/to/kubeconfig \
KUBERNETES_API_E2E_STAGE=manual \
node scripts/kubernetes-api-e2e/run.mjs
```
