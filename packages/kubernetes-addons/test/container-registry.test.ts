import { compareSync } from "bcryptjs";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import type { ClusterResource as DockerCluster } from "../../docker/src/types.ts";
import type { ClusterResource as HetznerCluster } from "../../hetzner/src/types.ts";
import {
  CONTAINER_REGISTRY_CHART,
  CONTAINER_REGISTRY_CHART_VERSION,
  CONTAINER_REGISTRY_IMAGE,
  ContainerRegistry,
  containerRegistryDockerConfig,
  containerRegistryHelmValues,
  containerRegistryHtpasswd,
  providers,
  validateContainerRegistryProps,
  type ContainerRegistryProps,
} from "../src/index.ts";

const acceptsCluster = (_cluster: ContainerRegistryProps["cluster"]): void =>
  undefined;
const compileClusterTypes = (
  hetzner: HetznerCluster,
  docker: DockerCluster,
): void => {
  acceptsCluster(hetzner);
  acceptsCluster(docker);
};
void compileClusterTypes;

const storage = {
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "registry",
  accessKeyId: "registry-access-key",
  secretAccessKey: Redacted.make("registry-secret-key"),
  sessionToken: Redacted.make("registry-session-token"),
  forcePathStyle: true,
};

const props = {
  cluster: {} as never,
  storage,
  ingress: {
    host: "registry.example.com",
    className: "traefik",
    tlsSecretName: "registry-tls",
  },
} satisfies ContainerRegistryProps;

describe("KubernetesAddons.ContainerRegistry", () => {
  it("exports the composite and its complete provider layer", () => {
    expect(ContainerRegistry).toBeTypeOf("function");
    expect(providers).toBeTypeOf("function");
  });

  it("pins the official chart and multi-architecture minimal image", () => {
    expect(CONTAINER_REGISTRY_CHART).toBe(
      "oci://ghcr.io/project-zot/helm-charts/zot",
    );
    expect(CONTAINER_REGISTRY_CHART_VERSION).toBe("0.1.122");
    expect(CONTAINER_REGISTRY_IMAGE).toBe(
      "ghcr.io/project-zot/zot-minimal:v2.1.20@sha256:73f26433b341f4a319963f7c5e169858663a10565e4037e71605737daee202ee",
    );
  });

  it("renders S3, HTTPS, auth, GC, and hardened chart settings without credentials", () => {
    const values = containerRegistryHelmValues({
      releaseName: "registry",
      storage,
      storagePrefix: "images/production",
      storageSecretName: "registry-storage",
      storageSecretRevision: "41",
      authSecretName: "registry-auth",
      authSecretRevision: "42",
      namespaceRevision: "43",
      ingress: {
        ...props.ingress,
        annotations: { "external-dns.alpha.kubernetes.io/ttl": "60" },
      },
      username: "publisher",
      garbageCollection: {
        interval: "12h",
        delay: "48h",
        timeWindowUtc: "23:00-02:00",
      },
    });

    expect(values).toMatchObject({
      fullnameOverride: "registry",
      replicaCount: 1,
      image: {
        repository: "ghcr.io/project-zot/zot-minimal",
        tag: expect.stringMatching(/^v2\.1\.20@sha256:/),
      },
      strategy: { type: "Recreate" },
      service: { type: "ClusterIP", port: 5000 },
      ingress: {
        enabled: true,
        className: "traefik",
        hosts: [{ host: "registry.example.com", paths: [{ path: "/" }] }],
        tls: [{ secretName: "registry-tls", hosts: ["registry.example.com"] }],
      },
      persistence: false,
      serviceAccount: { create: false, name: "registry" },
      env: [
        {
          name: "AWS_ACCESS_KEY_ID",
          valueFrom: {
            secretKeyRef: {
              name: "registry-storage",
              key: "access-key-id",
            },
          },
        },
        {
          name: "AWS_SECRET_ACCESS_KEY",
          valueFrom: {
            secretKeyRef: {
              name: "registry-storage",
              key: "secret-access-key",
            },
          },
        },
        {
          name: "AWS_SESSION_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "registry-storage",
              key: "session-token",
            },
          },
        },
      ],
      podSecurityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      podAnnotations: {
        "alchemy.run/namespace-revision": "43",
        "alchemy.run/storage-secret-revision": "41",
        "alchemy.run/auth-secret-revision": "42",
      },
    });

    const config = JSON.parse(
      (values.configFiles as Record<string, string>)["config.json"]!,
    ) as {
      storage: Record<string, unknown> & {
        storageDriver: Record<string, unknown>;
      };
      http: Record<string, unknown> & {
        accessControl: Record<string, unknown>;
      };
    };
    expect(config.storage).toMatchObject({
      dedupe: false,
      gc: true,
      gcDelay: "48h",
      gcInterval: "12h",
      gcTimeWindow: "23:00-02:00",
      redirectBlobURL: false,
      storageDriver: {
        name: "s3",
        region: "eu-central-1",
        bucket: "registry",
        regionendpoint: "https://s3.example.com",
        rootdirectory: "/images/production",
        forcepathstyle: true,
        secure: true,
        skipverify: false,
      },
    });
    expect(config.http).toMatchObject({
      auth: { htpasswd: { path: "/secrets/auth/htpasswd" } },
      accessControl: {
        repositories: { "**": { defaultPolicy: [] } },
        adminPolicy: {
          users: ["publisher"],
          actions: ["read", "create", "update", "delete"],
        },
      },
    });
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain("registry-access-key");
    expect(serialized).not.toContain("registry-secret-key");
    expect(serialized).not.toContain("registry-session-token");
  });

  it("omits the temporary-credential env reference when no session token exists", () => {
    const { sessionToken: _sessionToken, ...staticStorage } = storage;
    const values = containerRegistryHelmValues({
      releaseName: "registry",
      storage: staticStorage,
      storagePrefix: "registry",
      storageSecretName: "registry-storage",
      storageSecretRevision: "1",
      authSecretName: "registry-auth",
      authSecretRevision: "2",
      namespaceRevision: "3",
      ingress: props.ingress,
      username: "registry",
      garbageCollection: {
        interval: "24h",
        delay: "24h",
        timeWindowUtc: "02:00-04:00",
      },
    });
    expect(values.env).not.toContainEqual(
      expect.objectContaining({ name: "AWS_SESSION_TOKEN" }),
    );
  });

  it("creates a stable bcrypt-only htpasswd entry", () => {
    const password = Redacted.make("correct horse battery staple");
    const salt = Redacted.make("00112233445566778899aabbccddeeff");
    const first = Redacted.value(
      containerRegistryHtpasswd("publisher", password, salt),
    );
    const second = Redacted.value(
      containerRegistryHtpasswd("publisher", password, salt),
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^publisher:\$2b\$12\$/);
    expect(
      compareSync("correct horse battery staple", first.split(":")[1]!.trim()),
    ).toBe(true);
    expect(first).not.toContain("correct horse battery staple");
  });

  it("creates Docker credential JSON for external and node pulls", () => {
    const config = JSON.parse(
      Redacted.value(
        containerRegistryDockerConfig(
          "registry.example.com",
          "publisher",
          Redacted.make("secret"),
        ),
      ),
    ) as {
      auths: Record<
        string,
        { username: string; password: string; auth: string }
      >;
    };
    expect(config.auths["registry.example.com"]).toEqual({
      username: "publisher",
      password: "secret",
      auth: Buffer.from("publisher:secret").toString("base64"),
    });
  });

  it("rejects unsafe names, non-HTTPS exposure, and invalid storage/GC settings", () => {
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        ingress: { ...props.ingress, host: "https://registry.example.com" },
      }),
    ).toThrow("Invalid container registry ingress host");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        ingress: { ...props.ingress, tlsSecretName: "" },
      }),
    ).toThrow("Invalid container registry TLS Secret name");
    expect(() =>
      validateContainerRegistryProps({ ...props, storagePrefix: "../shared" }),
    ).toThrow("safe relative S3 prefix");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        storage: { ...storage, endpoint: "ftp://s3.example.com" },
      }),
    ).toThrow("must be an HTTP(S) URL");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        storage: { ...storage, secretAccessKey: Redacted.make("") },
      }),
    ).toThrow("S3 access fields must not be empty");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        credentials: { password: Redacted.make("") },
      }),
    ).toThrow("password must not be empty");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        credentials: { password: Redacted.make("a".repeat(73)) },
      }),
    ).toThrow("must not exceed 72 UTF-8 bytes");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        garbageCollection: { interval: "daily" },
      }),
    ).toThrow("positive Go durations");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        garbageCollection: { timeWindowUtc: "02:00-02:00" },
      }),
    ).toThrow("non-empty UTC");
    expect(() =>
      validateContainerRegistryProps({
        ...props,
        pullSecrets: { namespaces: ["apps", "apps"] },
      }),
    ).toThrow("must not contain duplicates");
  });
});
