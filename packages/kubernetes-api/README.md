# alchemy-kubernetes-native

Typed Kubernetes built-ins and a Pulumi-like object lifecycle for Alchemy. The
package generates thin constructors from a pinned `kubernetes-models` schema
snapshot and runs every object through one handwritten provider.

```sh
npm install alchemy-kubernetes-native alchemy effect
```

Register both Alchemy's cluster adapters and this provider:

```ts
import * as Alchemy from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as K8s from "alchemy-kubernetes-native";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "app",
  {
    providers: Layer.mergeAll(Kubernetes.providers(), K8s.providers()),
  },
  Effect.gen(function* () {
    const cluster = Kubernetes.KubeConfig({ context: "production" });
    return yield* K8s.apps.v1.StatefulSet("Database", {
      cluster,
      metadata: { name: "database", namespace: "apps" },
      spec: {
        serviceName: "database",
        replicas: 3,
        selector: { matchLabels: { app: "database" } },
        template: {
          metadata: { labels: { app: "database" } },
          spec: {
            containers: [{ name: "database", image: "postgres:18" }],
          },
        },
      },
    });
  }),
);
```

The output exposes typed `metadata`, `spec`, `status`, and `live` attributes.
The generator currently covers 39 stable resources in core/v1, apps/v1,
batch/v1, networking.k8s.io/v1, rbac.authorization.k8s.io/v1, autoscaling/v2,
policy/v1, storage.k8s.io/v1, and apiextensions.k8s.io/v1. Each constructor has
a matching `Patch` constructor, such as `apps.v1.StatefulSetPatch`.

## Lifecycle

The provider uses server-side apply with a stable field manager derived from the
resource FQN. `forceConflicts` defaults to `false`, so another controller's
fields are not silently stolen. Desired-field projection ignores API defaults,
status, and unrelated manager fields while still repairing drift in fields the
stack declares. Server dry-run catches validation, ownership conflicts, and
immutable updates during planning.

Every owned object is annotated with its Alchemy FQN and instance ID. An
existing object without matching annotations is reported as unowned. Adopt it
explicitly with Alchemy's normal `adopt(true)` policy; reconciliation then
claims only the fields present in the desired object. A process killed after
server-side apply can rediscover the same annotated object and continue without
manual cleanup.

Deletion uses the observed UID as a Kubernetes precondition, defaults to
foreground propagation, and waits until the object is physically absent. This
prevents stale state from deleting a newer object that reused the same name.
Patch resources never delete the underlying object.

Built-in readiness covers Namespace, CRD, Pod, Deployment, StatefulSet,
DaemonSet, Job, PVC, LoadBalancer Service, and Ingress. Other resources are
accepted once apply succeeds. Override that with `waitFor`, or use `skipAwait`
for a controller whose readiness is managed elsewhere:

```ts
yield *
  K8s.Object<MyWidget>("Widget", {
    cluster,
    manifest: {
      apiVersion: "example.io/v1",
      kind: "Widget",
      metadata: { name: "example", namespace: "apps" },
      spec: { size: 3 },
    },
    waitFor: { condition: "Ready" },
    timeoutSeconds: 180,
  });
```

The supported JSONPath wait syntax is deliberately bounded to dotted property
and numeric array paths, for example `{.status.endpoints[0].ready}`. Complex
predicates should be represented as Kubernetes conditions by the controller.

## YAML and Helm

`ConfigGroup` accepts objects, YAML strings, and files. It splits List and
multi-document YAML, orders namespaces and CRDs first, and creates an individual
Alchemy resource for every object. The children are dependency-chained so CRDs
reach Established before their custom resources are applied.

`HelmChart` runs `helm template` without a shell, sends values over stdin, and
feeds the rendered objects into `ConfigGroup`. Helm 3 must be available where
the Alchemy program is evaluated. Values must contain references to existing
Secrets rather than credentials.

```ts
yield *
  K8s.HelmChart("Controller", {
    cluster,
    chart: "controller",
    repository: "https://charts.example.com",
    version: "1.2.3",
    namespace: "controller-system",
    values: { existingSecret: "controller-credentials" },
  });
```

## Secrets and CRDs

`Secret` is intentionally absent from the generated API, generic `Object`,
ConfigGroup, and Helm output. Use `alchemy-kubernetes-addons`' write-only
`Secret`, which unwraps Redacted values only at the request boundary and never
reads data back into Alchemy state.

Custom resources stay generic. This package does not generate TypeScript from
CRDs and does not inspect installed CRDs during compilation. Applications may
supply their own interface to `Object<T>` when useful; the API server remains
the validation authority.

## Schema updates

`schema.lock.json` records the model version, license, selected groups,
resources, and digest of every source declaration used by the generator.
Generated output is committed. Update and verify it with:

```sh
npm run generate:kubernetes
npm run generate:kubernetes:check
```

The runtime still uses Kubernetes discovery, so unsupported or removed APIs fail
visibly against the target cluster instead of relying on a hard-coded REST
mapping.

The live matrix passed K3s `v1.36.3+k3s1` and `v1.35.7+k3s1` on 2026-08-27. Both
runs covered adoption, a true no-op plan, drift repair, immutable StatefulSet
replacement, a typed CRD with generic custom resource, and exact destroy.
