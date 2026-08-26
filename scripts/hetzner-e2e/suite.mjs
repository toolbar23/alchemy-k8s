import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";
import {
  BASE_CHANNEL,
  UPGRADE_CHANNEL,
  baselineDesired,
  expectedServerCount,
} from "./profiles.mjs";
import {
  ROOT,
  SUITE_DIR,
  assertInventory,
  assertKubeconfig,
  confirmProfile,
  deleteHcloudResource,
  estimatePrice,
  findLoadBalancerByIp,
  finishReport,
  hcloud,
  hcloudResourceExists,
  inventoryIds,
  kubectl,
  makeLedger,
  openContext,
  percentileSummary,
  phaseRank,
  profileSummary,
  readInventory,
  recordBenchmark,
  recordCheck,
  recordPhase,
  removeLedger,
  runAlchemy,
  runCommand,
  saveLedger,
  updateReport,
  waitUntil,
} from "./harness.mjs";

const { AbortSignal, fetch, structuredClone } = globalThis;

const PYTHON_IMAGE = "python:3.13.7-alpine3.22";

const yamlLiteral = (contents, spaces = 4) => {
  const indentation = " ".repeat(spaces);
  return contents
    .split("\n")
    .map((line) => `${indentation}${line}`)
    .join("\n");
};

const parseJsonLog = (output, name) => {
  const candidates = output
    .trim()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"));
  if (candidates.length === 0) {
    throw new Error(`${name} emitted no JSON result`);
  }
  return JSON.parse(candidates.at(-1));
};

const applyYaml = (context, manifest, logName) =>
  kubectl(context, ["apply", "-f", "-"], {
    input: manifest,
    logName,
    quiet: true,
  });

const namespaceName = (context, purpose) => {
  const safeRun = context.runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-24);
  return `hke2e-${purpose}-${context.profile}-${safeRun}`.slice(0, 63);
};

const setupNamespace = async (context, namespace, logName) => {
  await kubectl(
    context,
    ["delete", "namespace", namespace, "--ignore-not-found", "--wait=true"],
    {
      quiet: true,
      logName,
      timeoutMs: 5 * 60_000,
    },
  );
  const workload = await readFile(path.join(SUITE_DIR, "workload.py"), "utf8");
  await applyYaml(
    context,
    `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    alchemy-hetzner-e2e: "true"
    alchemy-hetzner-e2e-run: ${JSON.stringify(context.runId)}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: e2e-tools
  namespace: ${namespace}
data:
  workload.py: |
${yamlLiteral(workload)}
`,
    logName,
  );
};

const cleanupNamespace = async (context, namespace, logName) => {
  const deletion = await kubectl(
    context,
    ["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"],
    { allowFailure: true, quiet: true, logName },
  );
  if (deletion.code !== 0) return;
  await waitUntil(
    `namespace ${namespace} deletion`,
    async () => {
      const lookup = await kubectl(context, ["get", "namespace", namespace], {
        allowFailure: true,
        quiet: true,
        logName,
      });
      return lookup.code !== 0;
    },
    { timeoutMs: 5 * 60_000 },
  ).catch(() => undefined);
};

const waitForJob = async (context, namespace, name, logName) => {
  await kubectl(
    context,
    [
      "wait",
      "--namespace",
      namespace,
      "--for=condition=complete",
      `job/${name}`,
      "--timeout=10m",
    ],
    { quiet: true, logName, timeoutMs: 11 * 60_000 },
  );
  const logs = await kubectl(
    context,
    ["logs", "--namespace", namespace, `job/${name}`],
    { quiet: true, logName },
  );
  return parseJsonLog(logs.stdout, name);
};

const runDnsWorkload = async (context, namespace, count, logName) => {
  await applyYaml(
    context,
    `apiVersion: batch/v1
kind: Job
metadata:
  name: dns-egress
  namespace: ${namespace}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: benchmark
          image: ${PYTHON_IMAGE}
          command: ["python", "/scripts/workload.py", "dns", "--host", "kubernetes.default.svc.cluster.local", "--count", "${count}"]
          volumeMounts:
            - name: tools
              mountPath: /scripts
      volumes:
        - name: tools
          configMap:
            name: e2e-tools
`,
    logName,
  );
  return waitForJob(context, namespace, "dns-egress", logName);
};

const waitForTraefikAddress = async (context, logName) =>
  waitUntil(
    "Traefik public load balancer address",
    async () => {
      const service = await kubectl(
        context,
        [
          "get",
          "service",
          "traefik",
          "--namespace",
          "kube-system",
          "-o",
          "json",
        ],
        { quiet: true, logName },
      );
      const parsed = JSON.parse(service.stdout);
      return parsed.status?.loadBalancer?.ingress?.[0]?.ip;
    },
    { timeoutMs: 15 * 60_000, intervalMs: 10_000 },
  );

const deployHttpWorkload = async (context, namespace, logName) => {
  const route = `/e2e/${context.runId.replace(/[^a-zA-Z0-9-]+/g, "-")}`;
  await applyYaml(
    context,
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
  namespace: ${namespace}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: e2e-http
  template:
    metadata:
      labels:
        app: e2e-http
    spec:
      containers:
        - name: server
          image: ${PYTHON_IMAGE}
          command: ["python", "/scripts/workload.py", "http-server", "--port", "8080"]
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 1
            periodSeconds: 2
          volumeMounts:
            - name: tools
              mountPath: /scripts
      volumes:
        - name: tools
          configMap:
            name: e2e-tools
---
apiVersion: v1
kind: Service
metadata:
  name: http
  namespace: ${namespace}
spec:
  selector:
    app: e2e-http
  ports:
    - port: 80
      targetPort: 8080
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: http
  namespace: ${namespace}
  annotations:
    kubernetes.io/ingress.class: traefik
spec:
  rules:
    - http:
        paths:
          - path: ${route}
            pathType: Prefix
            backend:
              service:
                name: http
                port:
                  number: 80
`,
    logName,
  );
  await kubectl(
    context,
    [
      "rollout",
      "status",
      "deployment/http",
      "--namespace",
      namespace,
      "--timeout=10m",
    ],
    { quiet: true, logName, timeoutMs: 11 * 60_000 },
  );
  const address = await waitForTraefikAddress(context, logName);
  const url = `http://${address}${route}`;
  await waitUntil(
    `public ingress ${url}`,
    async () => {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) return false;
      const body = await response.json();
      return body.path?.startsWith(route);
    },
    { timeoutMs: 10 * 60_000, intervalMs: 5_000 },
  );
  const loadBalancer = await findLoadBalancerByIp(context, address);
  if (loadBalancer === undefined) {
    throw new Error(`No Hetzner load balancer owns Traefik address ${address}`);
  }
  const ids = new Set(context.ledger.ephemerals.loadBalancerIds);
  ids.add(loadBalancer.id);
  await saveLedger(context, {
    ephemerals: {
      ...context.ledger.ephemerals,
      loadBalancerIds: [...ids],
    },
  });
  return { url, address, loadBalancerId: loadBalancer.id };
};

const runStorageWorkload = async (context, namespace, sizeMiB, logName) => {
  const marker = `${context.runId}:${namespace}`;
  await applyYaml(
    context,
    `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
  namespace: ${namespace}
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: hcloud-volumes
  resources:
    requests:
      storage: 10Gi
---
apiVersion: batch/v1
kind: Job
metadata:
  name: storage-write
  namespace: ${namespace}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: benchmark
          image: ${PYTHON_IMAGE}
          command: ["python", "/scripts/workload.py", "storage", "--path", "/data", "--size-mib", "${sizeMiB}", "--marker", ${JSON.stringify(marker)}]
          volumeMounts:
            - name: tools
              mountPath: /scripts
            - name: data
              mountPath: /data
      volumes:
        - name: tools
          configMap:
            name: e2e-tools
        - name: data
          persistentVolumeClaim:
            claimName: data
`,
    logName,
  );
  const metrics = await waitForJob(
    context,
    namespace,
    "storage-write",
    logName,
  );
  const claim = await kubectl(
    context,
    ["get", "pvc", "data", "--namespace", namespace, "-o", "json"],
    { quiet: true, logName },
  );
  const volumeName = JSON.parse(claim.stdout).spec.volumeName;
  const volume = await kubectl(
    context,
    ["get", "pv", volumeName, "-o", "json"],
    {
      quiet: true,
      logName,
    },
  );
  const volumeId = Number(JSON.parse(volume.stdout).spec.csi.volumeHandle);
  if (!Number.isInteger(volumeId)) {
    throw new Error(`CSI returned invalid Hetzner volume handle: ${volumeId}`);
  }
  const volumeIds = new Set(context.ledger.ephemerals.volumeIds);
  volumeIds.add(volumeId);
  await saveLedger(context, {
    ephemerals: {
      ...context.ledger.ephemerals,
      volumeIds: [...volumeIds],
    },
  });
  await kubectl(
    context,
    ["delete", "job", "storage-write", "--namespace", namespace, "--wait=true"],
    { quiet: true, logName },
  );
  await applyYaml(
    context,
    `apiVersion: batch/v1
kind: Job
metadata:
  name: storage-read
  namespace: ${namespace}
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: verify
          image: ${PYTHON_IMAGE}
          command: ["python", "/scripts/workload.py", "verify-storage", "--path", "/data", "--marker", ${JSON.stringify(marker)}]
          volumeMounts:
            - name: tools
              mountPath: /scripts
            - name: data
              mountPath: /data
      volumes:
        - name: tools
          configMap:
            name: e2e-tools
        - name: data
          persistentVolumeClaim:
            claimName: data
`,
    logName,
  );
  const persistence = await waitForJob(
    context,
    namespace,
    "storage-read",
    logName,
  );
  return { ...metrics, persistent: persistence.persistent, volumeId };
};

const listNodes = async (context, logName) => {
  const result = await kubectl(context, ["get", "nodes", "-o", "json"], {
    quiet: true,
    logName,
  });
  return JSON.parse(result.stdout).items;
};

const runNetworkWorkload = async (context, namespace, logName) => {
  const nodes = await listNodes(context, logName);
  const schedulable = nodes.filter(
    (node) =>
      node.spec?.unschedulable !== true &&
      !(node.spec?.taints ?? []).some(
        (taint) =>
          taint.effect === "NoSchedule" || taint.effect === "NoExecute",
      ),
  );
  if (schedulable.length === 0)
    throw new Error("No schedulable benchmark node");
  const serverNode = schedulable[0].metadata.name;
  const clientNode = (schedulable[1] ?? schedulable[0]).metadata.name;
  await applyYaml(
    context,
    `apiVersion: v1
kind: Pod
metadata:
  name: tcp-server
  namespace: ${namespace}
  labels:
    app: tcp-server
spec:
  nodeName: ${serverNode}
  containers:
    - name: server
      image: ${PYTHON_IMAGE}
      command: ["python", "/scripts/workload.py", "tcp-server", "--port", "9000"]
      ports:
        - containerPort: 9000
      readinessProbe:
        tcpSocket:
          port: 9000
        initialDelaySeconds: 1
        periodSeconds: 2
      volumeMounts:
        - name: tools
          mountPath: /scripts
  volumes:
    - name: tools
      configMap:
        name: e2e-tools
---
apiVersion: v1
kind: Service
metadata:
  name: tcp-server
  namespace: ${namespace}
spec:
  selector:
    app: tcp-server
  ports:
    - port: 9000
`,
    logName,
  );
  await kubectl(
    context,
    [
      "wait",
      "pod/tcp-server",
      "--namespace",
      namespace,
      "--for=condition=Ready",
      "--timeout=10m",
    ],
    { quiet: true, logName, timeoutMs: 11 * 60_000 },
  );
  await applyYaml(
    context,
    `apiVersion: batch/v1
kind: Job
metadata:
  name: tcp-client
  namespace: ${namespace}
spec:
  backoffLimit: 0
  template:
    spec:
      nodeName: ${clientNode}
      restartPolicy: Never
      containers:
        - name: benchmark
          image: ${PYTHON_IMAGE}
          command: ["python", "/scripts/workload.py", "tcp-client", "--host", "tcp-server", "--port", "9000", "--size-mib", "256"]
          volumeMounts:
            - name: tools
              mountPath: /scripts
      volumes:
        - name: tools
          configMap:
            name: e2e-tools
`,
    logName,
  );
  const metrics = await waitForJob(context, namespace, "tcp-client", logName);
  return {
    ...metrics,
    mode: serverNode === clientNode ? "same-node" : "cross-node",
    serverNode,
    clientNode,
  };
};

const runSystemChecks = async (context, desired, logName) => {
  await assertKubeconfig(context);
  const inventory = await readInventory(context);
  assertInventory(context, desired, inventory);
  const nodes = await listNodes(context, logName);
  const expectedCount = expectedServerCount(context.profile, desired);
  if (nodes.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} Kubernetes nodes, found ${nodes.length}`,
    );
  }
  for (const node of nodes) {
    const ready = node.status?.conditions?.find(
      (condition) => condition.type === "Ready",
    );
    if (ready?.status !== "True") {
      throw new Error(`Node ${node.metadata.name} is not Ready`);
    }
    const version = node.status?.nodeInfo?.kubeletVersion;
    if (!version?.startsWith(`${desired.channel}.`)) {
      throw new Error(
        `Node ${node.metadata.name} runs ${version}, expected ${desired.channel}.x`,
      );
    }
  }
  const expectedWorkers = desired.workerPools.reduce(
    (total, pool) => total + pool.count,
    0,
  );
  const workers = nodes.filter(
    (node) =>
      node.metadata.labels?.["node-role.kubernetes.io/control-plane"] ===
        undefined &&
      node.metadata.labels?.["node-role.kubernetes.io/master"] === undefined,
  );
  if (workers.length !== expectedWorkers) {
    throw new Error(
      `Expected ${expectedWorkers} worker nodes, found ${workers.length}`,
    );
  }
  const rollouts = [
    ["deployment/coredns", "kube-system"],
    ["deployment/metrics-server", "kube-system"],
    ["deployment/hcloud-cloud-controller-manager", "kube-system"],
    ["deployment/hcloud-csi-controller", "kube-system"],
    ["daemonset/hcloud-csi-node", "kube-system"],
    ["deployment/traefik", "kube-system"],
    ["deployment/system-upgrade-controller", "system-upgrade"],
  ];
  for (const [resource, namespace] of rollouts) {
    await kubectl(
      context,
      [
        "rollout",
        "status",
        resource,
        "--namespace",
        namespace,
        "--timeout=10m",
      ],
      { quiet: true, logName, timeoutMs: 11 * 60_000 },
    );
  }
  await waitUntil(
    "metrics-server samples",
    async () => {
      const top = await kubectl(context, ["top", "nodes"], {
        allowFailure: true,
        quiet: true,
        logName,
      });
      return top.code === 0;
    },
    { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
  );
  const traefikAddress = await waitForTraefikAddress(context, logName);
  return {
    inventory,
    nodeNames: nodes.map((node) => node.metadata.name).sort(),
    versions: nodes.map((node) => node.status.nodeInfo.kubeletVersion).sort(),
    workers: workers.length,
    traefikAddress,
  };
};

const removeRecordedVolume = async (context, volumeId) => {
  const removed = await waitUntil(
    `Hetzner volume ${volumeId} cleanup`,
    async () => !(await hcloudResourceExists(context, "volumes", volumeId)),
    { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
  ).catch(() => false);
  if (!removed && (await hcloudResourceExists(context, "volumes", volumeId))) {
    await deleteHcloudResource(context, "volumes", volumeId);
    await waitUntil(
      `forced Hetzner volume ${volumeId} cleanup`,
      async () => !(await hcloudResourceExists(context, "volumes", volumeId)),
      { timeoutMs: 2 * 60_000 },
    );
  }
};

const runFunctionalWorkloads = async (context, benchmark) => {
  const purpose = benchmark ? "benchmark" : "checks";
  const namespace = namespaceName(context, purpose);
  const logName = purpose;
  let volumeId;
  try {
    await setupNamespace(context, namespace, logName);
    const dns = await runDnsWorkload(
      context,
      namespace,
      benchmark ? 30 : 5,
      logName,
    );
    const ingress = await deployHttpWorkload(context, namespace, logName);
    const storage = await runStorageWorkload(
      context,
      namespace,
      benchmark ? 256 : 8,
      logName,
    );
    volumeId = storage.volumeId;
    if (!benchmark) {
      const response = await fetch(ingress.url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) {
        throw new Error(
          `Ingress functional check returned HTTP ${response.status}`,
        );
      }
      return {
        dnsLookups: dns.dnsMs.length,
        egressStatus: dns.egressStatus,
        ingressAddress: ingress.address,
        ingressLoadBalancerId: ingress.loadBalancerId,
        storagePersistent: storage.persistent,
        volumeId: storage.volumeId,
      };
    }
    const apiSamples = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      await kubectl(context, ["get", "--raw=/readyz"], {
        quiet: true,
        logName,
      });
      apiSamples.push(performance.now() - started);
    }
    const network = await runNetworkWorkload(context, namespace, logName);
    const requestCount = 200;
    const concurrency = 10;
    const latencies = [];
    let failures = 0;
    let cursor = 0;
    const httpStarted = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const request = cursor;
          cursor += 1;
          if (request >= requestCount) return;
          const started = performance.now();
          try {
            const response = await fetch(`${ingress.url}?request=${request}`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (response.status !== 200) failures += 1;
            else await response.arrayBuffer();
          } catch {
            failures += 1;
          }
          latencies.push(performance.now() - started);
        }
      }),
    );
    const httpSeconds = (performance.now() - httpStarted) / 1000;
    if (failures > 0) {
      throw new Error(
        `${failures}/${requestCount} ingress benchmark requests failed`,
      );
    }
    return {
      api: percentileSummary(apiSamples),
      dns: percentileSummary(dns.dnsMs),
      egressMs: dns.egressMs,
      network,
      storage: {
        sizeMiB: storage.sizeMiB,
        writeMiBps: storage.writeMiBps,
        readMiBps: storage.readMiBps,
        persistent: storage.persistent,
      },
      ingress: {
        requests: requestCount,
        concurrency,
        failures,
        requestsPerSecond: requestCount / httpSeconds,
        latencyMs: percentileSummary(latencies),
        loadBalancerId: ingress.loadBalancerId,
      },
    };
  } finally {
    await cleanupNamespace(context, namespace, logName).catch((error) => {
      process.stderr.write(`Namespace cleanup warning: ${error.message}\n`);
    });
    if (volumeId !== undefined) await removeRecordedVolume(context, volumeId);
  }
};

const runPodStartupBenchmark = async (context) => {
  const namespace = namespaceName(context, "startup");
  const logName = "benchmark-startup";
  try {
    await setupNamespace(context, namespace, logName);
    const nodes = await listNodes(context, logName);
    const node = nodes.find(
      (candidate) =>
        candidate.spec?.unschedulable !== true &&
        !(candidate.spec?.taints ?? []).some(
          (taint) =>
            taint.effect === "NoSchedule" || taint.effect === "NoExecute",
        ),
    );
    if (node === undefined)
      throw new Error("No schedulable startup benchmark node");
    const samples = [];
    for (const kind of ["cold", "warm"]) {
      const name = `startup-${kind}`;
      const started = performance.now();
      await applyYaml(
        context,
        `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: ${namespace}
spec:
  nodeName: ${node.metadata.name}
  containers:
    - name: server
      image: ${PYTHON_IMAGE}
      command: ["python", "/scripts/workload.py", "http-server", "--port", "8080"]
      readinessProbe:
        httpGet:
          path: /ready
          port: 8080
        initialDelaySeconds: 1
        periodSeconds: 1
      volumeMounts:
        - name: tools
          mountPath: /scripts
  volumes:
    - name: tools
      configMap:
        name: e2e-tools
`,
        logName,
      );
      await kubectl(
        context,
        [
          "wait",
          "pod",
          name,
          "--namespace",
          namespace,
          "--for=condition=Ready",
          "--timeout=10m",
        ],
        { quiet: true, logName, timeoutMs: 11 * 60_000 },
      );
      samples.push({ kind, milliseconds: performance.now() - started });
      await kubectl(
        context,
        ["delete", "pod", name, "--namespace", namespace, "--wait=true"],
        { quiet: true, logName },
      );
    }
    return { node: node.metadata.name, samples };
  } finally {
    await cleanupNamespace(context, namespace, logName).catch(() => undefined);
  }
};

const preflightPhase = async (context) => {
  const started = performance.now();
  const versions = {};
  const commands = [
    ["node", ["--version"]],
    ["npm", ["--version"]],
    ["kubectl", ["version", "--client", "-o", "json"]],
    ["ssh", ["-V"]],
  ];
  for (const [command, args] of commands) {
    const result = await runCommand(context, command, args, {
      quiet: true,
      logName: "preflight",
    });
    versions[command] = (result.stdout || result.stderr).trim();
  }
  await runCommand(
    context,
    "npm",
    ["run", "build", "--workspace", "packages/hetzner"],
    { logName: "preflight-build", timeoutMs: 10 * 60_000 },
  );
  const [serverTypes, locations, channels] = await Promise.all([
    hcloud(context, "/server_types?per_page=50"),
    hcloud(context, "/locations?per_page=50"),
    fetch("https://update.k3s.io/v1-release/channels", {
      signal: AbortSignal.timeout(30_000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`K3s channel API returned HTTP ${response.status}`);
      }
      return response.json();
    }),
  ]);
  const requiredServerTypes = new Set(["cx23"]);
  const availableServerTypes = new Set(
    serverTypes.server_types.map(({ name }) => name),
  );
  for (const serverType of requiredServerTypes) {
    if (!availableServerTypes.has(serverType)) {
      throw new Error(
        `Required Hetzner server type ${serverType} is unavailable`,
      );
    }
  }
  const requiredLocations = new Set(["nbg1", "fsn1", "hel1"]);
  const availableLocations = new Set(
    locations.locations.map(({ name }) => name),
  );
  for (const location of requiredLocations) {
    if (!availableLocations.has(location)) {
      throw new Error(`Required Hetzner location ${location} is unavailable`);
    }
  }
  const channelMap = new Map(
    channels.data.map(({ id, latest }) => [id, latest]),
  );
  if (!channelMap.has(BASE_CHANNEL) || !channelMap.has(UPGRADE_CHANNEL)) {
    throw new Error(
      `Required K3s channels are unavailable: ${BASE_CHANNEL}, ${UPGRADE_CHANNEL}`,
    );
  }
  const desired = context.ledger?.desired ?? baselineDesired(context.profile);
  const inventory = await readInventory(context);
  if (
    context.ledger === undefined &&
    Object.values(inventoryIds(inventory)).some((ids) => ids.length > 0)
  ) {
    throw new Error(
      `Found Hetzner resources labeled for ${context.clusterId} without a local suite ledger; refusing to adopt them`,
    );
  }
  const price = await estimatePrice(context, desired);
  await runAlchemy(context, "plan", desired, "preflight-plan");
  process.stdout.write(
    `\nProfile ${context.profile}: ${JSON.stringify(profileSummary(context, desired))}\n` +
      `Estimated live cost: €${price.hourly.toFixed(4)}/hour net, monthly caps €${price.monthlyCap.toFixed(2)} (ephemeral scale/volume costs excluded)\n`,
  );
  await recordCheck(context, "preflight", {
    tools: versions,
    credentialSource: context.credentials.source,
    allowedCidrs: context.allowedCidrs,
    channels: {
      [BASE_CHANNEL]: channelMap.get(BASE_CHANNEL),
      [UPGRADE_CHANNEL]: channelMap.get(UPGRADE_CHANNEL),
    },
    price,
  });
  await recordPhase(
    context,
    "preflight",
    "passed",
    performance.now() - started,
  );
  return { price, inventory };
};

const deployDesired = async (
  context,
  desired,
  transitionPhase,
  finalPhase,
  logName,
) => {
  await saveLedger(context, { desired, phase: transitionPhase });
  const deployed = await runAlchemy(context, "deploy", desired, logName);
  const inventory = await readInventory(context);
  assertInventory(context, desired, inventory);
  await assertKubeconfig(context);
  await saveLedger(context, {
    desired,
    phase: finalPhase,
    resources: inventoryIds(inventory),
  });
  await updateReport(context, (report) => {
    report.resources = inventoryIds(inventory);
  });
  return { durationMs: deployed.durationMs, inventory };
};

const createPhase = async (context, { runPreflight = true } = {}) => {
  if (runPreflight) await preflightPhase(context);
  if (context.ledger === undefined) {
    await saveLedger(context, makeLedger(context));
  }
  const desired = context.ledger.desired;
  const price = await estimatePrice(context, desired);
  await confirmProfile(
    context,
    `Create/resume ${context.profile} (${profileSummary(context, desired).serverCount} server(s), ${desired.channel}) at approximately €${price.hourly.toFixed(4)}/hour net.`,
  );
  const previousPhase = context.ledger.phase;
  const finalPhase =
    phaseRank(previousPhase) > phaseRank("created") ? previousPhase : "created";
  const result = await deployDesired(
    context,
    desired,
    "creating",
    finalPhase,
    "create",
  );
  await recordBenchmark(context, "provisionOrReconcileMs", result.durationMs);
  await recordPhase(context, "create", "passed", result.durationMs, {
    resources: inventoryIds(result.inventory),
  });
  return result;
};

const checksPhase = async (
  context,
  { phaseName = "checks", ledgerPhase = "checked" } = {},
) => {
  const started = performance.now();
  const desired = context.ledger.desired;
  const systems = await runSystemChecks(context, desired, phaseName);
  const workloads = await runFunctionalWorkloads(context, false);
  await recordCheck(context, phaseName, {
    nodes: systems.nodeNames,
    versions: systems.versions,
    workers: systems.workers,
    traefikAddress: systems.traefikAddress,
    workloads,
  });
  await saveLedger(context, { phase: ledgerPhase });
  await recordPhase(context, phaseName, "passed", performance.now() - started);
};

const benchmarkPhase = async (context) => {
  const started = performance.now();
  await runSystemChecks(context, context.ledger.desired, "benchmark-system");
  const startup = await runPodStartupBenchmark(context);
  const workloads = await runFunctionalWorkloads(context, true);
  await recordBenchmark(context, "podStartup", startup);
  await recordBenchmark(context, "apiReadyzMs", workloads.api);
  await recordBenchmark(context, "dnsMs", workloads.dns);
  await recordBenchmark(context, "egressMs", workloads.egressMs);
  await recordBenchmark(context, "podNetwork", workloads.network);
  await recordBenchmark(context, "csiStorage", workloads.storage);
  await recordBenchmark(context, "publicIngress", workloads.ingress);
  await saveLedger(context, { phase: "benchmarked" });
  await recordPhase(
    context,
    "benchmark",
    "passed",
    performance.now() - started,
  );
};

const idempotencePhase = async (context) => {
  const before = await readInventory(context);
  const result = await deployDesired(
    context,
    context.ledger.desired,
    "checking-idempotence",
    "idempotent",
    "idempotence",
  );
  const beforeIds = inventoryIds(before);
  const afterIds = inventoryIds(result.inventory);
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
    throw new Error(
      `No-change deploy altered cloud resource IDs: ${JSON.stringify({ beforeIds, afterIds })}`,
    );
  }
  await recordCheck(context, "idempotence", { beforeIds, afterIds });
  await recordBenchmark(context, "idempotentDeployMs", result.durationMs);
  await recordPhase(context, "idempotence", "passed", result.durationMs);
};

const scalePhase = async (context) => {
  if (context.ledger.desired.workerPools.length === 0) {
    throw new Error(`Profile ${context.profile} has no worker pool to scale`);
  }
  const original = structuredClone(context.ledger.desired);
  const scaled = structuredClone(original);
  scaled.workerPools[0].count += 1;
  let restored = false;
  const started = performance.now();
  try {
    const up = await deployDesired(
      context,
      scaled,
      "scaling-up",
      "scaled-up",
      "scale-up",
    );
    await runSystemChecks(context, scaled, "scale-up-checks");
    const down = await deployDesired(
      context,
      original,
      "scaling-down",
      "scaled",
      "scale-down",
    );
    restored = true;
    await runSystemChecks(context, original, "scale-down-checks");
    await recordBenchmark(context, "scale", {
      upMs: up.durationMs,
      downMs: down.durationMs,
    });
    await recordPhase(context, "scale", "passed", performance.now() - started);
  } finally {
    if (!restored) {
      await deployDesired(
        context,
        original,
        "recovering-scale",
        "scaled",
        "scale-recovery",
      ).catch((error) => {
        process.stderr.write(`Scale recovery failed: ${error.message}\n`);
      });
    }
  }
};

const replacePhase = async (context) => {
  if (context.ledger.desired.workerPools.length === 0) {
    throw new Error(`Profile ${context.profile} has no worker pool to replace`);
  }
  const original = structuredClone(context.ledger.desired);
  const replacement = structuredClone(original);
  replacement.workerPools[0].replacementToken = `${context.runId}-replacement`;
  const poolName = original.workerPools[0].name;
  const poolIds = (inventory) =>
    inventory.servers
      .filter((server) => server.labels["k3s.pool"] === poolName)
      .map(({ id }) => id)
      .sort((left, right) => left - right);
  const before = await readInventory(context);
  let restored = false;
  const started = performance.now();
  try {
    const forward = await deployDesired(
      context,
      replacement,
      "replacing-worker",
      "worker-replaced",
      "replace-forward",
    );
    await runSystemChecks(context, replacement, "replace-forward-checks");
    if (
      JSON.stringify(poolIds(before)) ===
      JSON.stringify(poolIds(forward.inventory))
    ) {
      throw new Error(
        "Worker server IDs did not change during the same-size replacement",
      );
    }
    const backward = await deployDesired(
      context,
      original,
      "restoring-worker",
      "replaced",
      "replace-restore",
    );
    restored = true;
    await runSystemChecks(context, original, "replace-restore-checks");
    if (
      JSON.stringify(poolIds(forward.inventory)) ===
      JSON.stringify(poolIds(backward.inventory))
    ) {
      throw new Error(
        "Worker server IDs did not change while restoring the baseline generation",
      );
    }
    await recordBenchmark(context, "replacement", {
      forwardMs: forward.durationMs,
      restoreMs: backward.durationMs,
      serverType: original.workerPools[0].serverType,
      originalIds: poolIds(before),
      replacementIds: poolIds(forward.inventory),
      restoredIds: poolIds(backward.inventory),
    });
    await recordPhase(
      context,
      "replace",
      "passed",
      performance.now() - started,
    );
  } finally {
    if (!restored) {
      await deployDesired(
        context,
        original,
        "recovering-replacement",
        "replaced",
        "replace-recovery",
      ).catch((error) => {
        process.stderr.write(`Replacement recovery failed: ${error.message}\n`);
      });
    }
  }
};

const upgradePhase = async (context) => {
  const current = context.ledger.desired;
  if (current.channel === UPGRADE_CHANNEL) {
    await runSystemChecks(context, current, "upgrade-already-complete");
    await saveLedger(context, { phase: "upgraded" });
    await recordPhase(context, "upgrade", "passed", 0, {
      message: `${UPGRADE_CHANNEL} already active`,
    });
    return;
  }
  if (current.channel !== BASE_CHANNEL) {
    throw new Error(
      `Upgrade only supports ${BASE_CHANNEL} -> ${UPGRADE_CHANNEL}; current desired channel is ${current.channel}`,
    );
  }
  const upgraded = structuredClone(current);
  upgraded.channel = UPGRADE_CHANNEL;
  const result = await deployDesired(
    context,
    upgraded,
    "upgrading",
    "upgraded",
    "upgrade",
  );
  const systems = await runSystemChecks(context, upgraded, "upgrade-checks");
  const jobs = await kubectl(
    context,
    ["get", "jobs", "--namespace", "system-upgrade", "-o", "json"],
    { quiet: true, logName: "upgrade-checks", allowFailure: true },
  );
  if (jobs.code === 0) {
    const failed = JSON.parse(jobs.stdout).items.filter(
      (job) => (job.status?.failed ?? 0) > 0,
    );
    if (failed.length > 0) {
      throw new Error(
        `Failed System Upgrade jobs: ${failed.map((job) => job.metadata.name).join(", ")}`,
      );
    }
  }
  await recordBenchmark(context, "minorUpgradeMs", result.durationMs);
  await recordCheck(context, "upgrade", {
    from: BASE_CHANNEL,
    to: UPGRADE_CHANNEL,
    versions: systems.versions,
  });
  await recordPhase(context, "upgrade", "passed", result.durationMs);
};

const protectionPhase = async (context) => {
  if (!context.ledger.desired.protected) {
    throw new Error("Deletion-protection test requires a protected cluster");
  }
  const before = inventoryIds(await readInventory(context));
  const attempted = await runAlchemy(
    context,
    "destroy",
    context.ledger.desired,
    "protection",
    { allowFailure: true },
  );
  if (attempted.code === 0) {
    throw new Error("Protected destroy unexpectedly succeeded");
  }
  const after = inventoryIds(await readInventory(context));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Protected destroy changed cloud resources: ${JSON.stringify({ before, after })}`,
    );
  }
  await saveLedger(context, { phase: "protection-verified" });
  await recordCheck(context, "deletionProtection", {
    destroyExitCode: attempted.code,
    before,
    after,
  });
  await recordPhase(context, "protection", "passed", attempted.durationMs);
};

const cleanupEphemeralNamespaces = async (context) => {
  const namespaces = await kubectl(
    context,
    [
      "get",
      "namespaces",
      "--selector",
      "alchemy-hetzner-e2e=true",
      "-o",
      "json",
    ],
    { quiet: true, logName: "destroy-cleanup", allowFailure: true },
  );
  if (namespaces.code !== 0) return;
  for (const item of JSON.parse(namespaces.stdout).items) {
    await cleanupNamespace(context, item.metadata.name, "destroy-cleanup");
  }
};

const cleanupTraefikLoadBalancer = async (context) => {
  let loadBalancerId;
  const address = await waitForTraefikAddress(context, "destroy-cleanup").catch(
    () => undefined,
  );
  if (address !== undefined) {
    const loadBalancer = await findLoadBalancerByIp(context, address);
    loadBalancerId = loadBalancer?.id;
    if (loadBalancerId !== undefined) {
      const ids = new Set(context.ledger.ephemerals.loadBalancerIds);
      ids.add(loadBalancerId);
      await saveLedger(context, {
        ephemerals: {
          ...context.ledger.ephemerals,
          loadBalancerIds: [...ids],
        },
      });
    }
  }
  await kubectl(
    context,
    [
      "delete",
      "helmchart.helm.cattle.io",
      "traefik",
      "traefik-crd",
      "--namespace",
      "kube-system",
      "--ignore-not-found",
    ],
    { quiet: true, logName: "destroy-cleanup", allowFailure: true },
  );
  await kubectl(
    context,
    [
      "delete",
      "service",
      "traefik",
      "--namespace",
      "kube-system",
      "--ignore-not-found",
      "--wait=true",
    ],
    { quiet: true, logName: "destroy-cleanup", allowFailure: true },
  );
  if (loadBalancerId === undefined) return;
  const removed = await waitUntil(
    `Traefik load balancer ${loadBalancerId} deletion`,
    async () =>
      !(await hcloudResourceExists(context, "load_balancers", loadBalancerId)),
    { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
  ).catch(() => false);
  if (!removed) {
    await deleteHcloudResource(context, "load_balancers", loadBalancerId);
  }
};

const destroyPhase = async (context) => {
  const price = await estimatePrice(context, context.ledger.desired);
  await confirmProfile(
    context,
    `Destroy ${context.profile}, including exact suite-owned Kubernetes volumes/load balancers. Current estimated cost is €${price.hourly.toFixed(4)}/hour net.`,
  );
  const started = performance.now();
  await cleanupEphemeralNamespaces(context);
  for (const volumeId of context.ledger.ephemerals.volumeIds) {
    if (await hcloudResourceExists(context, "volumes", volumeId)) {
      await removeRecordedVolume(context, volumeId);
    }
  }
  const unprotected = structuredClone(context.ledger.desired);
  unprotected.protected = false;
  await deployDesired(
    context,
    unprotected,
    "disabling-protection",
    "unprotected",
    "destroy-unprotect",
  );
  await cleanupTraefikLoadBalancer(context);
  const destroyed = await runAlchemy(
    context,
    "destroy",
    unprotected,
    "destroy",
  );
  const inventory = await readInventory(context);
  const remaining = inventoryIds(inventory);
  if (Object.values(remaining).some((ids) => ids.length > 0)) {
    throw new Error(
      `Owned Hetzner resources remain after destroy: ${JSON.stringify(remaining)}`,
    );
  }
  for (const loadBalancerId of context.ledger.ephemerals.loadBalancerIds) {
    if (await hcloudResourceExists(context, "load_balancers", loadBalancerId)) {
      throw new Error(
        `Recorded application load balancer ${loadBalancerId} remains after destroy`,
      );
    }
  }
  await recordPhase(context, "destroy", "passed", performance.now() - started, {
    alchemyMs: destroyed.durationMs,
  });
  await finishReport(context, "passed-and-destroyed");
  await removeLedger(context.profile);
  context.ledger = undefined;
};

const allPhase = async (context) => {
  const started = performance.now();
  await preflightPhase(context);
  if (
    context.ledger !== undefined &&
    phaseRank(context.ledger.phase) === -1 &&
    (context.ledger.phase.includes("scal") ||
      context.ledger.phase.includes("replac"))
  ) {
    const baseline = baselineDesired(context.profile);
    baseline.channel = context.ledger.desired.channel;
    await deployDesired(
      context,
      baseline,
      "recovering-baseline",
      "created",
      "all-recovery",
    );
  }
  await createPhase(context, { runPreflight: false });
  if (phaseRank(context.ledger.phase) < phaseRank("checked")) {
    await checksPhase(context);
  }
  if (phaseRank(context.ledger.phase) < phaseRank("benchmarked")) {
    await benchmarkPhase(context);
  }
  if (phaseRank(context.ledger.phase) < phaseRank("idempotent")) {
    await idempotencePhase(context);
  }
  if (phaseRank(context.ledger.phase) < phaseRank("scaled")) {
    if (context.ledger.desired.workerPools.length === 0) {
      await recordPhase(context, "scale", "not-applicable", 0);
      await saveLedger(context, { phase: "scaled" });
    } else {
      await scalePhase(context);
    }
  }
  if (phaseRank(context.ledger.phase) < phaseRank("replaced")) {
    if (context.ledger.desired.workerPools.length === 0) {
      await recordPhase(context, "replace", "not-applicable", 0);
      await saveLedger(context, { phase: "replaced" });
    } else {
      await replacePhase(context);
    }
  }
  if (phaseRank(context.ledger.phase) < phaseRank("upgraded")) {
    await upgradePhase(context);
  }
  if (phaseRank(context.ledger.phase) < phaseRank("post-upgrade-checked")) {
    await checksPhase(context, {
      phaseName: "post-upgrade-checks",
      ledgerPhase: "post-upgrade-checked",
    });
  }
  if (phaseRank(context.ledger.phase) < phaseRank("protection-verified")) {
    await protectionPhase(context);
  }
  await recordPhase(context, "all", "passed", performance.now() - started);
  await finishReport(context, "passed-cluster-retained");
  const price = await estimatePrice(context, context.ledger.desired);
  process.stdout.write(
    `\nFull suite passed. ${context.profile} remains protected and running on ${context.ledger.desired.channel}.\n` +
      `Report: ${path.relative(ROOT, context.reportDir)}/report.md\n` +
      `Current estimate: €${price.hourly.toFixed(4)}/hour net.\n` +
      `Teardown: npm run e2e:hetzner:destroy -- --profile ${context.profile}\n`,
  );
};

const phaseFunctions = {
  preflight: preflightPhase,
  create: createPhase,
  checks: checksPhase,
  benchmark: benchmarkPhase,
  idempotence: idempotencePhase,
  scale: scalePhase,
  replace: replacePhase,
  upgrade: upgradePhase,
  protection: protectionPhase,
  all: allPhase,
  destroy: destroyPhase,
};

export const runNamedPhase = async (name, argv) => {
  const phase = phaseFunctions[name];
  if (phase === undefined) throw new Error(`Unknown suite phase: ${name}`);
  const context = await openContext(argv, {
    requireLedger: !["preflight", "create", "all"].includes(name),
  });
  try {
    await phase(context);
  } catch (error) {
    await recordPhase(context, name, "failed", undefined, {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    await finishReport(context, "failed").catch(() => undefined);
    throw error;
  }
};
