import * as Alchemy from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as K8s from "alchemy-kubernetes-native";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import process from "node:process";

const kubeconfig = process.env.KUBERNETES_API_E2E_KUBECONFIG;
const stage = process.env.KUBERNETES_API_E2E_STAGE;
const serviceName = process.env.KUBERNETES_API_E2E_SERVICE ?? "database-v1";
if (kubeconfig === undefined || stage === undefined) {
  throw new Error(
    "KUBERNETES_API_E2E_KUBECONFIG and KUBERNETES_API_E2E_STAGE are required",
  );
}
if (!/^[a-z][a-z0-9-]{0,30}$/.test(stage)) {
  throw new Error("KUBERNETES_API_E2E_STAGE must be a short Kubernetes name");
}

const namespaceName = `typed-api-${stage}`;
const group = `${stage}.alchemy.run`;
const cluster = Kubernetes.KubeConfig({ path: kubeconfig });

export default Alchemy.Stack(
  "KubernetesApiE2E",
  {
    providers: Layer.mergeAll(Kubernetes.providers(), K8s.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const namespace = yield* K8s.core.v1
      .Namespace("Namespace", {
        cluster,
        metadata: { name: namespaceName },
      })
      .pipe(Alchemy.AdoptPolicy.adopt(true));

    const config = yield* K8s.core.v1
      .ConfigMap("AdoptedConfig", {
        cluster,
        dependsOn: namespace.resourceVersion,
        fieldManager: "typed-api-e2e",
        metadata: { name: "settings", namespace: namespaceName },
        data: { value: "desired" },
      })
      .pipe(Alchemy.AdoptPolicy.adopt(true));

    const service = yield* K8s.core.v1.Service("HeadlessService", {
      cluster,
      dependsOn: config.resourceVersion,
      metadata: { name: serviceName, namespace: namespaceName },
      spec: {
        clusterIP: "None",
        selector: { app: "database" },
        ports: [{ name: "tcp", port: 5432, targetPort: 5432 }],
      },
    });

    const database = yield* K8s.apps.v1.StatefulSet("Database", {
      cluster,
      dependsOn: service.resourceVersion,
      metadata: { name: "database", namespace: namespaceName },
      spec: {
        serviceName,
        replicas: 1,
        selector: { matchLabels: { app: "database" } },
        template: {
          metadata: { labels: { app: "database" } },
          spec: {
            containers: [
              {
                name: "database",
                image: "registry.k8s.io/pause:3.10.1",
                imagePullPolicy: "IfNotPresent",
              },
            ],
          },
        },
      },
      timeoutSeconds: 300,
    });

    const crd = yield* K8s.apiextensions.v1.CustomResourceDefinition(
      "WidgetCrd",
      {
        cluster,
        dependsOn: database.resourceVersion,
        metadata: { name: `widgets.${group}` },
        spec: {
          group,
          scope: "Namespaced",
          names: {
            plural: "widgets",
            singular: "widget",
            kind: "Widget",
          },
          versions: [
            {
              name: "v1",
              served: true,
              storage: true,
              schema: {
                openAPIV3Schema: {
                  type: "object",
                  properties: {
                    spec: {
                      type: "object",
                      properties: { size: { type: "integer" } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    );

    const widget = yield* K8s.Object("Widget", {
      cluster,
      dependsOn: crd.resourceVersion,
      manifest: {
        apiVersion: `${group}/v1`,
        kind: "Widget",
        metadata: { name: "example", namespace: namespaceName },
        spec: { size: 3 },
      },
      skipAwait: true,
    });

    return {
      namespace: namespace.name,
      configResourceVersion: config.resourceVersion,
      statefulSetReadyReplicas: database.status.readyReplicas,
      widgetUid: widget.uid,
    };
  }),
);
