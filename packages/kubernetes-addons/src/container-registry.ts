import { makeRandom, type Input } from "alchemy";
import * as Kubernetes from "alchemy/Kubernetes";
import * as Output from "alchemy/Output";
import type { S3BucketAccess } from "alchemy-s3-access";
import { encodeBase64, hashSync, truncates } from "bcryptjs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ReadyHelmChart, Secret } from "./index.ts";

export const CONTAINER_REGISTRY_CHART =
  "oci://ghcr.io/project-zot/helm-charts/zot";
export const CONTAINER_REGISTRY_CHART_VERSION = "0.1.122";
const CONTAINER_REGISTRY_IMAGE_REPOSITORY = "ghcr.io/project-zot/zot-minimal";
const CONTAINER_REGISTRY_IMAGE_VERSION = "v2.1.20";
const CONTAINER_REGISTRY_IMAGE_DIGEST =
  "sha256:73f26433b341f4a319963f7c5e169858663a10565e4037e71605737daee202ee";
const CONTAINER_REGISTRY_IMAGE_TAG = `${CONTAINER_REGISTRY_IMAGE_VERSION}@${CONTAINER_REGISTRY_IMAGE_DIGEST}`;
export const CONTAINER_REGISTRY_IMAGE = `${CONTAINER_REGISTRY_IMAGE_REPOSITORY}:${CONTAINER_REGISTRY_IMAGE_TAG}`;

export interface ContainerRegistryIngressProps {
  host: string;
  /** Existing IngressClass. The add-on does not install an ingress controller. */
  className?: string;
  /** TLS Secret in the registry namespace. The add-on does not issue it. */
  tlsSecretName: string;
  annotations?: Record<string, string>;
}

export interface ContainerRegistryGarbageCollectionProps {
  /** Zot/Go duration. @default "24h" */
  interval?: string;
  /** Minimum age before unreferenced content is collected. @default "24h" */
  delay?: string;
  /** Daily UTC start window in HH:MM-HH:MM form. @default "02:00-04:00" */
  timeWindowUtc?: string;
}

export interface ContainerRegistryPullSecretsProps {
  /** Pre-existing application namespaces that receive Docker pull credentials. */
  namespaces: string[];
  /** @default `${releaseName}-pull` */
  name?: string;
}

export interface ContainerRegistryProps {
  cluster: Input<Kubernetes.ClusterLike>;
  storage: S3BucketAccess;
  ingress: ContainerRegistryIngressProps;
  namespace?: string;
  releaseName?: string;
  /** Own the registry namespace. Disable when another resource owns it. @default true */
  createNamespace?: boolean;
  /** Relative prefix reserved for registry objects in the supplied bucket. @default "registry" */
  storagePrefix?: string;
  credentials?: {
    username?: string;
    password?: Redacted.Redacted<string>;
  };
  pullSecrets?: ContainerRegistryPullSecretsProps;
  garbageCollection?: ContainerRegistryGarbageCollectionProps;
  timeoutSeconds?: number;
}

export interface ContainerRegistryPullSecretRef {
  namespace: string;
  name: string;
  resourceVersion: Input<string | undefined>;
}

export interface ContainerRegistryResult {
  namespace: string;
  releaseName: string;
  serviceName: string;
  host: string;
  url: string;
  imagePrefix: string;
  internalUrl: string;
  credentials: {
    username: string;
    password: Input<Redacted.Redacted<string>>;
  };
  pullSecretRefs: ContainerRegistryPullSecretRef[];
  ingress: {
    host: string;
    url: string;
    tls: true;
  };
}

interface ContainerRegistryHelmValuesProps {
  releaseName: string;
  storage: Pick<
    S3BucketAccess,
    "endpoint" | "region" | "bucket" | "forcePathStyle" | "sessionToken"
  >;
  storagePrefix: string;
  storageSecretName: string;
  storageSecretRevision: Input<string>;
  authSecretName: string;
  authSecretRevision: Input<string>;
  namespaceRevision: Input<string>;
  ingress: ContainerRegistryIngressProps;
  username: string;
  garbageCollection: Required<ContainerRegistryGarbageCollectionProps>;
}

const kubernetesName = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const dnsSubdomain =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const goDuration = /^(?:[1-9]\d*(?:\.\d+)?(?:ms|s|m|h))+$/;
const utcWindow = /^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/;

export const validateContainerRegistryProps = (
  props: ContainerRegistryProps,
): void => {
  const namespace = props.namespace ?? "registry";
  const releaseName = props.releaseName ?? "registry";
  const username = props.credentials?.username ?? "registry";
  const pullSecretName = props.pullSecrets?.name ?? `${releaseName}-pull`;
  const storagePrefix = props.storagePrefix ?? "registry";
  const garbageCollection = {
    interval: props.garbageCollection?.interval ?? "24h",
    delay: props.garbageCollection?.delay ?? "24h",
    timeWindowUtc: props.garbageCollection?.timeWindowUtc ?? "02:00-04:00",
  };

  if (!kubernetesName.test(namespace) || namespace.length > 63) {
    throw new Error(`Invalid container registry namespace: ${namespace}`);
  }
  if (!kubernetesName.test(releaseName) || releaseName.length > 53) {
    throw new Error(`Invalid container registry release name: ${releaseName}`);
  }
  if (
    username.trim() === "" ||
    username.includes(":") ||
    username.includes("\n") ||
    username.includes("\r")
  ) {
    throw new Error(
      "Container registry username must be non-empty and contain no colon or newline",
    );
  }
  if (
    props.credentials?.password !== undefined &&
    Redacted.value(props.credentials.password) === ""
  ) {
    throw new Error("Container registry password must not be empty");
  }
  if (
    props.credentials?.password !== undefined &&
    truncates(Redacted.value(props.credentials.password))
  ) {
    throw new Error(
      "Container registry password must not exceed 72 UTF-8 bytes",
    );
  }
  if (!dnsSubdomain.test(props.ingress.host)) {
    throw new Error(
      `Invalid container registry ingress host: ${props.ingress.host}`,
    );
  }
  if (
    props.ingress.className !== undefined &&
    !dnsSubdomain.test(props.ingress.className)
  ) {
    throw new Error(
      `Invalid container registry ingress class: ${props.ingress.className}`,
    );
  }
  if (
    !kubernetesName.test(props.ingress.tlsSecretName) ||
    props.ingress.tlsSecretName.length > 63
  ) {
    throw new Error(
      `Invalid container registry TLS Secret name: ${props.ingress.tlsSecretName}`,
    );
  }
  if (!kubernetesName.test(pullSecretName) || pullSecretName.length > 63) {
    throw new Error(
      `Invalid container registry pull Secret name: ${pullSecretName}`,
    );
  }
  const pullNamespaces = props.pullSecrets?.namespaces ?? [];
  if (
    pullNamespaces.some(
      (name) => !kubernetesName.test(name) || name.length > 63,
    )
  ) {
    throw new Error("Invalid container registry pull Secret namespace");
  }
  if (new Set(pullNamespaces).size !== pullNamespaces.length) {
    throw new Error(
      "Container registry pull Secret namespaces must not contain duplicates",
    );
  }
  if (
    storagePrefix === "" ||
    storagePrefix.startsWith("/") ||
    storagePrefix.endsWith("/") ||
    storagePrefix
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    !/^[A-Za-z0-9._/-]+$/.test(storagePrefix)
  ) {
    throw new Error(
      "Container registry storagePrefix must be a safe relative S3 prefix",
    );
  }
  if (
    props.storage.region.trim() === "" ||
    props.storage.bucket.trim() === "" ||
    props.storage.accessKeyId.trim() === "" ||
    Redacted.value(props.storage.secretAccessKey) === "" ||
    (props.storage.sessionToken !== undefined &&
      Redacted.value(props.storage.sessionToken) === "")
  ) {
    throw new Error("Container registry S3 access fields must not be empty");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(props.storage.endpoint);
  } catch {
    throw new Error("Container registry S3 endpoint must be a valid URL");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "Container registry S3 endpoint must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  if (
    !goDuration.test(garbageCollection.interval) ||
    !goDuration.test(garbageCollection.delay)
  ) {
    throw new Error(
      "Container registry garbage-collection interval and delay must be positive Go durations",
    );
  }
  if (
    !utcWindow.test(garbageCollection.timeWindowUtc) ||
    garbageCollection.timeWindowUtc.slice(0, 5) ===
      garbageCollection.timeWindowUtc.slice(6)
  ) {
    throw new Error(
      "Container registry garbage-collection window must be a non-empty UTC HH:MM-HH:MM range",
    );
  }
  if (
    props.timeoutSeconds !== undefined &&
    (!Number.isFinite(props.timeoutSeconds) || props.timeoutSeconds <= 0)
  ) {
    throw new Error(
      "Container registry timeoutSeconds must be greater than zero",
    );
  }
};

export const containerRegistryHtpasswd = (
  username: string,
  password: Redacted.Redacted<string>,
  saltSeed: Redacted.Redacted<string>,
): Redacted.Redacted<string> => {
  const plainPassword = Redacted.value(password);
  if (truncates(plainPassword)) {
    throw new Error(
      "Container registry password must not exceed 72 UTF-8 bytes",
    );
  }
  const plainSaltSeed = Redacted.value(saltSeed);
  if (!/^[a-f0-9]{32}$/.test(plainSaltSeed)) {
    throw new Error("Container registry bcrypt salt seed must be 16 bytes");
  }
  const salt = `$2b$12$${encodeBase64(Buffer.from(plainSaltSeed, "hex"), 16)}`;
  return Redacted.make(`${username}:${hashSync(plainPassword, salt)}\n`);
};

export const containerRegistryDockerConfig = (
  host: string,
  username: string,
  password: Redacted.Redacted<string>,
): Redacted.Redacted<string> => {
  const plainPassword = Redacted.value(password);
  return Redacted.make(
    JSON.stringify({
      auths: {
        [host]: {
          username,
          password: plainPassword,
          auth: Buffer.from(`${username}:${plainPassword}`).toString("base64"),
        },
      },
    }),
  );
};

export const containerRegistryHelmValues = ({
  releaseName,
  storage,
  storagePrefix,
  storageSecretName,
  storageSecretRevision,
  authSecretName,
  authSecretRevision,
  namespaceRevision,
  ingress,
  username,
  garbageCollection,
}: ContainerRegistryHelmValuesProps): Record<string, unknown> => {
  const endpoint = new URL(storage.endpoint);
  const configuration = {
    distSpecVersion: "1.1.1",
    storage: {
      rootDirectory: "/var/lib/registry",
      dedupe: false,
      gc: true,
      gcDelay: garbageCollection.delay,
      gcInterval: garbageCollection.interval,
      gcTimeWindow: garbageCollection.timeWindowUtc,
      fastRestart: false,
      redirectBlobURL: false,
      storageDriver: {
        name: "s3",
        region: storage.region,
        bucket: storage.bucket,
        regionendpoint: storage.endpoint,
        rootdirectory: `/${storagePrefix}`,
        forcepathstyle: storage.forcePathStyle ?? false,
        secure: endpoint.protocol === "https:",
        skipverify: false,
        v4auth: true,
      },
    },
    http: {
      address: "0.0.0.0",
      port: "5000",
      readTimeout: "15m",
      writeTimeout: "15m",
      auth: { htpasswd: { path: "/secrets/auth/htpasswd" } },
      accessControl: {
        repositories: { "**": { defaultPolicy: [] } },
        adminPolicy: {
          users: [username],
          actions: ["read", "create", "update", "delete"],
        },
      },
    },
    log: { level: "info" },
  };

  return {
    fullnameOverride: releaseName,
    replicaCount: 1,
    image: {
      repository: CONTAINER_REGISTRY_IMAGE_REPOSITORY,
      tag: CONTAINER_REGISTRY_IMAGE_TAG,
      pullPolicy: "IfNotPresent",
    },
    strategy: { type: "Recreate" },
    service: { type: "ClusterIP", port: 5000 },
    ingress: {
      enabled: true,
      annotations: ingress.annotations ?? {},
      className: ingress.className ?? "",
      pathtype: "Prefix",
      hosts: [{ host: ingress.host, paths: [{ path: "/" }] }],
      tls: [{ secretName: ingress.tlsSecretName, hosts: [ingress.host] }],
    },
    mountConfig: true,
    configFiles: { "config.json": JSON.stringify(configuration) },
    externalSecrets: [
      { secretName: authSecretName, mountPath: "/secrets/auth" },
    ],
    persistence: false,
    env: [
      {
        name: "AWS_ACCESS_KEY_ID",
        valueFrom: {
          secretKeyRef: { name: storageSecretName, key: "access-key-id" },
        },
      },
      {
        name: "AWS_SECRET_ACCESS_KEY",
        valueFrom: {
          secretKeyRef: { name: storageSecretName, key: "secret-access-key" },
        },
      },
      ...(storage.sessionToken === undefined
        ? []
        : [
            {
              name: "AWS_SESSION_TOKEN",
              valueFrom: {
                secretKeyRef: {
                  name: storageSecretName,
                  key: "session-token",
                },
              },
            },
          ]),
    ],
    serviceAccount: { create: false, name: releaseName },
    resources: {
      requests: { cpu: "25m", memory: "64Mi" },
      limits: { memory: "512Mi" },
    },
    podSecurityContext: {
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      fsGroup: 65532,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    },
    securityContext: {
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 65532,
      runAsGroup: 65532,
      capabilities: { drop: ["ALL"] },
    },
    extraVolumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
    extraVolumes: [{ name: "tmp", emptyDir: {} }],
    metrics: { enabled: false, serviceMonitor: { enabled: false } },
    podAnnotations: {
      "alchemy.run/namespace-revision": namespaceRevision,
      "alchemy.run/storage-secret-revision": storageSecretRevision,
      "alchemy.run/auth-secret-revision": authSecretRevision,
    },
  };
};

/** Deploy a private, HTTPS-only, S3-backed OCI/Docker registry. */
export const ContainerRegistry = (id: string, props: ContainerRegistryProps) =>
  Effect.gen(function* () {
    yield* Effect.try(() => validateContainerRegistryProps(props));

    const namespaceName = props.namespace ?? "registry";
    const releaseName = props.releaseName ?? "registry";
    const createNamespace = props.createNamespace ?? true;
    const username = props.credentials?.username ?? "registry";
    const password =
      props.credentials?.password ??
      (yield* makeRandom(`${id}RegistryPassword`));
    const saltSeed = yield* makeRandom(`${id}RegistryBcryptSalt`, {
      bytes: 16,
    });
    const htpasswd = Output.map(
      Output.all(Output.asOutput(password), Output.asOutput(saltSeed)),
      ([resolvedPassword, resolvedSaltSeed]) =>
        containerRegistryHtpasswd(username, resolvedPassword, resolvedSaltSeed),
    );

    let namespaceRevision: Input<string> = "external";
    let secretNamespace: Input<string> = namespaceName;
    if (createNamespace) {
      const namespace = yield* Kubernetes.Manifest(`${id}Namespace`, {
        cluster: props.cluster,
        manifest: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespaceName },
        },
      });
      namespaceRevision = Output.map(namespace.uid, (uid) => uid ?? "created");
      secretNamespace = namespace.name;
    }

    const storageSecretName = `${releaseName}-storage`;
    const storageSecret = yield* Secret(`${id}StorageCredentials`, {
      cluster: props.cluster,
      namespace: secretNamespace,
      name: storageSecretName,
      stringData: {
        "access-key-id": props.storage.accessKeyId,
        "secret-access-key": props.storage.secretAccessKey,
        ...(props.storage.sessionToken === undefined
          ? {}
          : { "session-token": props.storage.sessionToken }),
      },
    });
    const authSecretName = `${releaseName}-auth`;
    const authSecret = yield* Secret(`${id}Authentication`, {
      cluster: props.cluster,
      namespace: secretNamespace,
      name: authSecretName,
      stringData: { htpasswd },
    });
    const serviceAccount = yield* Kubernetes.Manifest(`${id}ServiceAccount`, {
      cluster: authSecret.connection,
      manifest: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: releaseName, namespace: namespaceName },
        automountServiceAccountToken: false,
      },
    });

    const dockerConfig = Output.map(Output.asOutput(password), (resolved) =>
      containerRegistryDockerConfig(props.ingress.host, username, resolved),
    );
    const pullSecretName = props.pullSecrets?.name ?? `${releaseName}-pull`;
    const pullSecretRefs: ContainerRegistryPullSecretRef[] = [];
    for (const targetNamespace of props.pullSecrets?.namespaces ?? []) {
      const pullSecret = yield* Secret(`${id}PullSecret${targetNamespace}`, {
        cluster: props.cluster,
        namespace: targetNamespace,
        name: pullSecretName,
        type: "kubernetes.io/dockerconfigjson",
        stringData: { ".dockerconfigjson": dockerConfig },
      });
      pullSecretRefs.push({
        namespace: targetNamespace,
        name: pullSecretName,
        resourceVersion: pullSecret.resourceVersion,
      });
    }

    const values = containerRegistryHelmValues({
      releaseName,
      storage: props.storage,
      storagePrefix: props.storagePrefix ?? "registry",
      storageSecretName,
      storageSecretRevision: Output.map(
        storageSecret.resourceVersion,
        (resourceVersion) => resourceVersion ?? "unknown",
      ),
      authSecretName,
      authSecretRevision: Output.map(
        authSecret.resourceVersion,
        (resourceVersion) => resourceVersion ?? "unknown",
      ),
      namespaceRevision,
      ingress: props.ingress,
      username,
      garbageCollection: {
        interval: props.garbageCollection?.interval ?? "24h",
        delay: props.garbageCollection?.delay ?? "24h",
        timeWindowUtc: props.garbageCollection?.timeWindowUtc ?? "02:00-04:00",
      },
    });

    yield* ReadyHelmChart(`${id}Chart`, {
      cluster: serviceAccount.connection,
      chart: CONTAINER_REGISTRY_CHART,
      version: CONTAINER_REGISTRY_CHART_VERSION,
      releaseName,
      namespace: namespaceName,
      createNamespace: false,
      timeoutSeconds: props.timeoutSeconds ?? 300,
      values,
    });

    const url = `https://${props.ingress.host}`;
    return {
      namespace: namespaceName,
      releaseName,
      serviceName: releaseName,
      host: props.ingress.host,
      url,
      imagePrefix: props.ingress.host,
      internalUrl: `http://${releaseName}.${namespaceName}.svc.cluster.local:5000`,
      credentials: { username, password },
      pullSecretRefs,
      ingress: { host: props.ingress.host, url, tls: true },
    } satisfies ContainerRegistryResult;
  });
