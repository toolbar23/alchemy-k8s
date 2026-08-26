import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Stack } from "alchemy";
import { TokenAdapter } from "alchemy/Kubernetes";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Secret,
  SecretProvider,
  kubernetesObjectReadiness,
  type Secret as SecretResource,
} from "../src/index.ts";
import { objectPath, requestJson, waitForObjectsReady } from "../src/client.ts";

const canary = "phase0-canary-secret-value";
const connection: {
  endpoint: string;
  auth: { kind: "token"; token: string };
} = {
  endpoint: "",
  auth: { kind: "token", token: "test-token" },
};

interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
}

let requests: ApiRequest[];
let storedSecret: Record<string, unknown> | undefined;
let failPatch: boolean;
let failGet: boolean;
let failDelete: boolean;
let server: Server;

beforeEach(async () => {
  requests = [];
  storedSecret = undefined;
  failPatch = false;
  failGet = false;
  failDelete = false;
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
      let responseBody = "";
      if (method === "PATCH" && failPatch) {
        response.statusCode = 422;
        responseBody = JSON.stringify({ message: `invalid ${canary}` });
      } else if (method === "GET" && failGet) {
        response.statusCode = 500;
        responseBody = JSON.stringify({ message: `failed ${canary}` });
      } else if (method === "PATCH") {
        storedSecret = body as Record<string, unknown>;
        response.statusCode = 200;
        responseBody = JSON.stringify({
          ...storedSecret,
          metadata: {
            ...((storedSecret.metadata as object | undefined) ?? {}),
            uid: "uid-1",
            resourceVersion: String(requests.length),
          },
        });
      } else if (method === "GET" && storedSecret !== undefined) {
        response.statusCode = 200;
        responseBody = path.includes("/secrets/")
          ? JSON.stringify({
              apiVersion: "v1",
              kind: "Secret",
              type: storedSecret.type,
              metadata: {
                name: "credentials",
                namespace: "apps",
                uid: "uid-1",
                resourceVersion: "observed-2",
              },
              data: { token: Buffer.from(canary).toString("base64") },
            })
          : JSON.stringify(storedSecret);
      } else if (method === "DELETE" && failDelete) {
        response.statusCode = 500;
        responseBody = JSON.stringify({ message: `failed ${canary}` });
      } else if (method === "DELETE") {
        storedSecret = undefined;
        response.statusCode = 200;
      } else {
        response.statusCode = 404;
        responseBody = JSON.stringify({ message: "not found" });
      }
      response.setHeader("content-type", "application/json");
      response.end(responseBody);
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

const runSecretProvider = <A>(
  operation: (provider: any) => Effect.Effect<A, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Secret.Provider;
      return yield* operation(provider);
    }).pipe(
      Effect.provide(SecretProvider()),
      Effect.provide(TokenAdapter),
    ) as Effect.Effect<A, unknown>,
  );

describe("KubernetesAddons.Secret", () => {
  it("redacts literal inputs before resource registration", () => {
    const stack = {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    };
    const resource = Effect.runSync(
      Effect.provideService(
        Secret("Credentials", {
          cluster: connection,
          name: "credentials",
          stringData: { token: canary },
        }) as Effect.Effect<SecretResource>,
        Stack,
        stack,
      ),
    );
    expect(Redacted.isRedacted(resource.Props.stringData.token)).toBe(true);
    expect(JSON.stringify(resource.Props)).not.toContain(canary);

    const lazyResource = Effect.runSync(
      Effect.provideService(
        Secret("LazyCredentials", {
          cluster: connection,
          name: "lazy-credentials",
          stringData: { token: Effect.succeed(canary) },
        }) as Effect.Effect<SecretResource>,
        Stack,
        stack,
      ),
    );
    const lazyToken = lazyResource.Props.stringData
      .token as Redacted.Redacted<string>;
    expect(Redacted.isRedacted(lazyToken)).toBe(true);
    expect(Redacted.value(lazyToken)).toBe(canary);
    expect(JSON.stringify(lazyResource.Props)).not.toContain(canary);

    const failed = Effect.runSyncExit(
      Effect.provideService(
        Secret("FailedCredentials", {
          cluster: connection,
          name: "failed-credentials",
          stringData: {
            token: Effect.fail(new Error(`failed to resolve ${canary}`)),
          },
        }) as Effect.Effect<SecretResource>,
        Stack,
        stack,
      ),
    );
    expect(String(failed)).toContain(
      "Failed to resolve Kubernetes Secret input",
    );
    expect(String(failed)).not.toContain(canary);
  });

  it("performs write-only create, update, read, idempotent apply, and delete", async () => {
    const notes: string[] = [];
    const news = {
      cluster: connection,
      namespace: "apps",
      name: "credentials",
      type: "Opaque",
      immutable: false,
      stringData: { token: Redacted.make(canary) },
    };
    const session = {
      note: (note: string) => Effect.sync(() => notes.push(note)),
    };
    const create = await runSecretProvider((provider) =>
      provider.reconcile({ news, session } as never),
    );
    expect(
      (requests.at(-1)?.body as { stringData: { token: string } }).stringData
        .token,
    ).toBe(canary);
    expect(JSON.stringify(create)).not.toContain(canary);
    expect(notes.join("\n")).not.toContain(canary);

    const read = await runSecretProvider((provider) =>
      provider.read({ output: create } as never),
    );
    expect(read).toMatchObject({
      name: "credentials",
      namespace: "apps",
      uid: "uid-1",
      resourceVersion: "observed-2",
    });
    expect(JSON.stringify(read)).not.toContain(canary);

    const updated = {
      ...news,
      stringData: { token: Redacted.make("rotated-token") },
    };
    await runSecretProvider((provider) =>
      provider.reconcile({ news: updated, output: create, session } as never),
    );
    expect(
      (requests.at(-1)?.body as { stringData: { token: string } }).stringData
        .token,
    ).toBe("rotated-token");
    await runSecretProvider((provider) =>
      provider.reconcile({ news: updated, output: create, session } as never),
    );
    expect(requests.at(-1)?.method).toBe("PATCH");

    await runSecretProvider((provider) =>
      provider.delete({ output: create } as never),
    );
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/v1/namespaces/apps/secrets/credentials",
    });
  });

  it("does not copy a Kubernetes error body containing the Secret", async () => {
    failPatch = true;
    const session = { note: () => Effect.void };
    const error = await runSecretProvider((provider) =>
      Effect.flip(
        provider.reconcile({
          news: {
            cluster: connection,
            name: "credentials",
            stringData: { token: Redacted.make(canary) },
          },
          session,
        } as never),
      ),
    );
    expect(String(error)).toContain("Kubernetes API returned 422");
    expect(String(error)).not.toContain(canary);
  });

  it("sanitizes read errors without copying the Kubernetes response", async () => {
    const session = { note: () => Effect.void };
    const created = await runSecretProvider((provider) =>
      provider.reconcile({
        news: {
          cluster: connection,
          namespace: "apps",
          name: "credentials",
          stringData: { token: Redacted.make(canary) },
        },
        session,
      } as never),
    );
    failGet = true;
    const error = await runSecretProvider((provider) =>
      Effect.flip(provider.read({ output: created } as never)),
    );
    expect(String(error)).toContain("Kubernetes API returned 500");
    expect(String(error)).not.toContain(canary);
  });

  it("retains the exact Secret when cleanup fails", async () => {
    const session = { note: () => Effect.void };
    const created = await runSecretProvider((provider) =>
      provider.reconcile({
        news: {
          cluster: connection,
          namespace: "apps",
          name: "credentials",
          stringData: { token: Redacted.make(canary) },
        },
        session,
      } as never),
    );
    failDelete = true;
    const error = await runSecretProvider((provider) =>
      Effect.flip(provider.delete({ output: created } as never)),
    );
    expect(String(error)).toContain("Kubernetes API returned 500");
    expect(String(error)).not.toContain(canary);
    expect(storedSecret).toBeDefined();
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/v1/namespaces/apps/secrets/credentials",
    });
  });
});

describe("KubernetesAddons readiness", () => {
  it("uses the cluster-scoped cert-manager issuer endpoint", () => {
    expect(
      objectPath({
        apiVersion: "cert-manager.io/v1",
        kind: "ClusterIssuer",
        name: "letsencrypt-staging",
      }),
    ).toBe("/apis/cert-manager.io/v1/clusterissuers/letsencrypt-staging");
  });

  const deploymentRef = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    namespace: "apps",
    name: "controller",
  };
  const transport = {
    endpoint: "http://kubernetes.test",
    headers: Effect.succeed({}),
  };

  it("refuses to send Kubernetes credentials over remote HTTP", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        requestJson({
          transport: { ...transport, endpoint: "http://kubernetes.example" },
          method: "GET",
          path: "/api/v1/namespaces/default/secrets/example",
        }),
      ),
    );
    expect(String(error)).toContain("Refusing to send Kubernetes credentials");
  });

  it("recognizes CRD and workload readiness", () => {
    expect(
      kubernetesObjectReadiness({
        kind: "CustomResourceDefinition",
        status: { conditions: [{ type: "Established", status: "True" }] },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "Job",
        status: { conditions: [{ type: "Complete", status: "True" }] },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "Deployment",
        metadata: { generation: 2 },
        spec: { replicas: 3 },
        status: { observedGeneration: 2, availableReplicas: 3 },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "DaemonSet",
        metadata: { generation: 1 },
        status: {
          observedGeneration: 1,
          desiredNumberScheduled: 3,
          numberAvailable: 3,
        },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "StatefulSet",
        metadata: { generation: 1 },
        spec: { replicas: 2 },
        status: { observedGeneration: 1, readyReplicas: 2 },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "ClusterIssuer",
        status: { conditions: [{ type: "Ready", status: "True" }] },
      }).ready,
    ).toBe(true);
    expect(
      kubernetesObjectReadiness({
        kind: "ClusterIssuer",
        status: { conditions: [{ type: "Ready", status: "False" }] },
      }),
    ).toMatchObject({ ready: false, terminal: false });
  });

  it("returns success, terminal failure, and sanitized timeout errors", async () => {
    transport.endpoint = connection.endpoint;
    storedSecret = {
      kind: "Deployment",
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, availableReplicas: 1 },
    };
    await expect(
      Effect.runPromise(
        waitForObjectsReady({
          transport,
          objects: [deploymentRef],
          timeoutSeconds: 1,
        }),
      ),
    ).resolves.toBeUndefined();

    storedSecret = {
      kind: "Job",
      status: {
        conditions: [
          {
            type: "Failed",
            status: "True",
            reason: canary,
            message: canary,
          },
        ],
      },
    };
    const jobFailure = await Effect.runPromise(
      Effect.flip(
        waitForObjectsReady({
          transport,
          objects: [
            {
              apiVersion: "batch/v1",
              kind: "Job",
              namespace: "apps",
              name: "setup",
            },
          ],
          timeoutSeconds: 1,
        }),
      ),
    );
    expect(String(jobFailure)).toContain("batch/v1/Job apps/setup");
    expect(String(jobFailure)).not.toContain(canary);

    storedSecret = {
      kind: "Deployment",
      metadata: { generation: 2 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 1,
        availableReplicas: canary,
        conditions: [
          { type: "Progressing", status: "True", message: canary },
          { type: canary, status: "True" },
        ],
      },
    };
    const timeout = await Effect.runPromise(
      Effect.flip(
        waitForObjectsReady({
          transport,
          objects: [deploymentRef],
          timeoutSeconds: 0.05,
        }),
      ),
    );
    expect(String(timeout)).toContain("apps/controller");
    expect(String(timeout)).toContain("observedGeneration=1/2");
    expect(String(timeout)).toContain("availableReplicas=0/1");
    expect(String(timeout)).not.toContain(canary);

    failGet = true;
    const apiFailure = await Effect.runPromise(
      Effect.flip(
        waitForObjectsReady({
          transport,
          objects: [deploymentRef],
          timeoutSeconds: 1,
        }),
      ),
    );
    expect(String(apiFailure)).toContain("Kubernetes API returned 500");
    expect(String(apiFailure)).not.toContain(canary);
  });
});
