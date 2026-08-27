import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Unowned } from "alchemy/AdoptPolicy";
import { TokenAdapter } from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FQN_ANNOTATION,
  INSTANCE_ANNOTATION,
  ObjectProvider,
  ObjectResource,
  desiredObject,
  desiredProjection,
  type KubernetesObject,
  type ObjectAttributes,
  type ObjectProps,
} from "../src/index.ts";

interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
}

const connection: {
  endpoint: string;
  auth: { kind: "token"; token: string };
} = {
  endpoint: "",
  auth: { kind: "token", token: "test-token" },
};

const fqn = "Test/Database";
const instanceId = "instance-1";
const session = { note: () => Effect.void };
const props = (): ObjectProps => ({
  cluster: connection,
  manifest: {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name: "database", namespace: "apps" },
    spec: {
      replicas: 1,
      serviceName: "database",
      selector: { matchLabels: { app: "database" } },
      template: {
        metadata: { labels: { app: "database" } },
        spec: { containers: [{ name: "db", image: "postgres:18" }] },
      },
    },
  },
});

let requests: ApiRequest[];
let stored: KubernetesObject | undefined;
let server: Server;
let resourceVersion: number;
let failAfterApply: boolean;
let conflict: boolean;
let immutable: boolean;

beforeEach(async () => {
  requests = [];
  stored = undefined;
  resourceVersion = 0;
  failAfterApply = false;
  conflict = false;
  immutable = false;
  server = createServer((request, response) => {
    let payload = "";
    request.on("data", (chunk) => {
      payload += chunk.toString();
    });
    request.on("end", () => {
      const method = request.method ?? "GET";
      const path = request.url ?? "/";
      const body = payload.length === 0 ? undefined : JSON.parse(payload);
      requests.push({ method, path, body });
      response.setHeader("content-type", "application/json");

      if (method === "GET" && path === "/apis/apps/v1") {
        response.end(
          JSON.stringify({
            resources: [
              {
                name: "statefulsets",
                kind: "StatefulSet",
                namespaced: true,
              },
            ],
          }),
        );
        return;
      }
      if (method === "PATCH" && conflict) {
        response.statusCode = 409;
        response.end(JSON.stringify({ message: "managed field conflict" }));
        return;
      }
      if (method === "PATCH" && immutable) {
        response.statusCode = 422;
        response.end(JSON.stringify({ message: "spec is immutable" }));
        return;
      }
      if (method === "PATCH") {
        const desired = body as KubernetesObject;
        resourceVersion += 1;
        stored = {
          ...desired,
          metadata: {
            ...desired.metadata,
            uid: stored?.metadata.uid ?? "uid-1",
            resourceVersion: String(resourceVersion),
            generation: resourceVersion,
            managedFields: [{ manager: "test" }],
          },
          status: {
            observedGeneration: resourceVersion,
            readyReplicas: 1,
          },
        };
        if (path.includes("dryRun=All")) {
          response.end(JSON.stringify(stored));
          return;
        }
        if (failAfterApply) {
          failAfterApply = false;
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify(stored));
        return;
      }
      if (method === "GET" && path.includes("/statefulsets/database")) {
        if (stored === undefined) {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "not found" }));
        } else {
          response.end(JSON.stringify(stored));
        }
        return;
      }
      if (method === "DELETE") {
        const expectedUid = (
          body as { preconditions?: { uid?: string } } | undefined
        )?.preconditions?.uid;
        if (expectedUid !== undefined && expectedUid !== stored?.metadata.uid) {
          response.statusCode = 409;
          response.end(JSON.stringify({ message: "UID precondition failed" }));
          return;
        }
        stored = undefined;
        response.end(JSON.stringify({ kind: "Status", status: "Success" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  connection.endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

const runProvider = <A>(
  operation: (provider: any) => Effect.Effect<A, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* ObjectResource.Provider;
      return yield* operation(provider);
    }).pipe(
      Effect.provide(ObjectProvider()),
      Effect.provide(TokenAdapter),
    ) as Effect.Effect<A, unknown>,
  );

const reconcile = (news = props()): Promise<ObjectAttributes> =>
  runProvider((provider) =>
    provider.reconcile({ fqn, instanceId, news, session } as never),
  );

describe("KubernetesApi.Object provider", () => {
  it("applies with stack ownership, waits for readiness, and sanitizes live state", async () => {
    const output = await reconcile();
    expect(output).toMatchObject({
      uid: "uid-1",
      resourceVersion: "1",
      generation: 1,
      status: { readyReplicas: 1 },
    });
    expect(output.metadata).not.toHaveProperty("managedFields");
    const patch = requests.find(({ method }) => method === "PATCH")!;
    expect(patch.path).toMatch(/fieldManager=alchemy-[a-f0-9]{20}(?:&|$)/);
    expect(patch.path).not.toContain("force=true");
    expect(patch.body).toMatchObject({
      metadata: {
        annotations: {
          [FQN_ANNOTATION]: fqn,
          [INSTANCE_ANNOTATION]: instanceId,
        },
      },
    });
  });

  it("recovers an apply that succeeded before state could be committed", async () => {
    failAfterApply = true;
    await expect(reconcile()).rejects.toThrow("Kubernetes API request failed");
    expect(stored?.metadata.uid).toBe("uid-1");

    const observed = await runProvider((provider) =>
      provider.read({ fqn, instanceId, olds: props() } as never),
    );
    expect(Unowned.is(observed)).toBe(false);
    expect(observed).toMatchObject({ uid: "uid-1" });

    const recovered = await reconcile();
    expect(recovered.uid).toBe("uid-1");
  });

  it("requires adoption for an existing foreign object and then claims it", async () => {
    stored = {
      ...props().manifest,
      metadata: {
        ...props().manifest.metadata,
        uid: "foreign-uid",
        resourceVersion: "1",
      },
      status: { observedGeneration: 1, readyReplicas: 1 },
    };
    const observed = await runProvider((provider) =>
      provider.read({ fqn, instanceId, olds: props() } as never),
    );
    expect(Unowned.is(observed)).toBe(true);

    const adopted = await reconcile();
    expect(adopted.uid).toBe("foreign-uid");
    expect(stored?.metadata.annotations).toMatchObject({
      [FQN_ANNOTATION]: fqn,
      [INSTANCE_ANNOTATION]: instanceId,
    });
  });

  it("detects owned-field drift but ignores defaults and status", async () => {
    const output = await reconcile();
    const noDrift = await runProvider((provider) =>
      provider.diff({
        fqn,
        instanceId,
        olds: props(),
        news: props(),
        output,
      } as never),
    );
    expect(noDrift).toEqual({ action: "noop" });

    const drifted = {
      ...output,
      live: {
        ...output.live,
        spec: { ...(output.live.spec as object), replicas: 2 },
      },
    };
    stored = {
      ...stored!,
      spec: { ...(stored!.spec as object), replicas: 2 },
    };
    const drift = await runProvider((provider) =>
      provider.diff({
        fqn,
        instanceId,
        olds: props(),
        news: props(),
        output: drifted,
      } as never),
    );
    expect(drift).toEqual({ action: "update" });
    expect(requests.at(-1)?.path).toContain("dryRun=All");
  });

  it("turns immutable dry-run failures into delete-first replacement", async () => {
    const output = await reconcile();
    immutable = true;
    const changed = props();
    changed.manifest = {
      ...changed.manifest,
      spec: { ...(changed.manifest.spec as object), serviceName: "new-name" },
    };
    const diff = await runProvider((provider) =>
      provider.diff({
        fqn,
        instanceId,
        olds: props(),
        news: changed,
        output,
      } as never),
    );
    expect(diff).toEqual({ action: "replace", deleteFirst: true });
  });

  it("reports SSA conflicts unless takeover is explicit", async () => {
    const output = await reconcile();
    conflict = true;
    const drifted = {
      ...output,
      live: {
        ...output.live,
        spec: { ...(output.live.spec as object), replicas: 2 },
      },
    };
    stored = {
      ...stored!,
      spec: { ...(stored!.spec as object), replicas: 2 },
    };
    await expect(
      runProvider((provider) =>
        provider.diff({
          fqn,
          instanceId,
          olds: props(),
          news: props(),
          output: drifted,
        } as never),
      ),
    ).rejects.toThrow("field ownership conflict");
  });

  it("deletes with a UID precondition and waits for physical absence", async () => {
    const output = await reconcile();
    await runProvider((provider) =>
      provider.delete({ olds: props(), output, session } as never),
    );
    expect(stored).toBeUndefined();
    const deletion = requests.find(({ method }) => method === "DELETE")!;
    expect(deletion.body).toMatchObject({
      propagationPolicy: "Foreground",
      preconditions: { uid: "uid-1" },
    });
  });

  it("never deletes the object represented by an SSA patch resource", async () => {
    const patchProps = { ...props(), mode: "patch" as const };
    const output = await reconcile(patchProps);
    const before = requests.filter(({ method }) => method === "DELETE").length;
    await runProvider((provider) =>
      provider.delete({ olds: patchProps, output, session } as never),
    );
    expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(
      before,
    );
    expect(stored).toBeDefined();
  });

  it("rejects Secret state and never repeats an API response body", async () => {
    const canary = "never-persist-this-secret";
    expect(() =>
      desiredObject({
        fqn,
        instanceId,
        props: {
          cluster: connection,
          manifest: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: "credentials", namespace: "apps" },
            stringData: { token: canary },
          },
        },
      }),
    ).toThrow("KubernetesAddons.Secret");
    expect(() =>
      desiredObject({
        fqn,
        instanceId,
        props: {
          cluster: connection,
          manifest: {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: "credentials", namespace: "apps" },
            stringData: { token: canary },
          },
        },
      }),
    ).not.toThrow(canary);
  });
});

describe("desired projection", () => {
  it("matches associative lists by their merge key and ignores extra fields", () => {
    const desired = {
      spec: {
        containers: [
          { name: "api", image: "api:v2" },
          { name: "sidecar", image: "sidecar:v1" },
        ],
      },
    };
    const live = {
      status: { ready: true },
      spec: {
        containers: [
          { name: "sidecar", image: "sidecar:v1", imagePullPolicy: "Always" },
          { name: "api", image: "api:v2", imagePullPolicy: "IfNotPresent" },
        ],
      },
    };
    expect(desiredProjection(desired, live)).toEqual(desired);
  });
});
