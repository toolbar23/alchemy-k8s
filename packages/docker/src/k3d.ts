import { run } from "../../shared/src/process.ts";
import type { ClusterStateProps } from "./types.ts";

const contextName = (
  context: ClusterStateProps["context"],
): string | undefined => {
  if (context === undefined) return undefined;
  return typeof context === "string" ? context : context.name;
};

export const dockerEnvironment = async (
  context: ClusterStateProps["context"],
): Promise<NodeJS.ProcessEnv> => {
  const name = contextName(context);
  if (name === undefined || name === "default") return process.env;
  const inspected = await run("docker", [
    "context",
    "inspect",
    name,
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  const host = inspected.stdout.trim();
  if (host.length === 0)
    throw new Error(`Docker context ${name} has no endpoint`);
  return { ...process.env, DOCKER_HOST: host };
};

export const requireK3d = async (): Promise<void> => {
  let output: string;
  try {
    output = (await run("k3d", ["version"])).stdout;
  } catch (error) {
    throw new Error(
      "k3d >=5.9.0 <6 is required; install it from https://k3d.io",
      {
        cause: error,
      },
    );
  }
  const match = /k3d version v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (match === null || Number(match[1]) !== 5 || Number(match[2]) < 9) {
    throw new Error(`k3d >=5.9.0 <6 is required; received ${output.trim()}`);
  }
};

export const buildCreateArgs = (
  props: ClusterStateProps,
  version: string,
  token?: string,
): string[] => {
  const args = [
    "cluster",
    "create",
    props.name,
    "--servers",
    "1",
    "--agents",
    "0",
    "--image",
    `rancher/k3s:${version.replace("+", "-")}`,
    "--volume",
    `${props.volume.name}:/var/lib/rancher/k3s@server:0`,
    "--kubeconfig-update-default=false",
    "--kubeconfig-switch-context=false",
    "--wait",
  ];
  if (props.apiPort !== undefined)
    args.push("--api-port", `127.0.0.1:${props.apiPort}`);
  if (token !== undefined) args.push("--token", token);
  for (const port of props.ports) {
    args.push(
      "--port",
      `${port.hostPort}:${port.containerPort}/${port.protocol ?? "tcp"}@loadbalancer`,
    );
  }
  for (const value of [
    `--cluster-cidr=${props.k3s.clusterCidr}`,
    `--service-cidr=${props.k3s.serviceCidr}`,
    `--cluster-dns=${props.k3s.clusterDns}`,
  ]) {
    args.push("--k3s-arg", `${value}@server:0`);
  }
  if (!props.k3s.addons.traefik)
    args.push("--k3s-arg", "--disable=traefik@server:0");
  if (!props.k3s.addons.metricsServer) {
    args.push("--k3s-arg", "--disable=metrics-server@server:0");
  }
  return args;
};

export interface K3dCluster {
  name: string;
  clusterToken?: string;
  nodes?: Array<{
    name: string;
    role: string;
    image: string;
    State?: { Running?: boolean };
  }>;
  serversRunning?: number;
}

export const inspectK3dCluster = async (
  props: ClusterStateProps,
): Promise<K3dCluster | undefined> => {
  const env = await dockerEnvironment(props.context);
  const listed = await run("k3d", ["cluster", "list", "-o", "json"], {
    env,
  });
  const clusters = JSON.parse(listed.stdout) as K3dCluster[];
  if (!clusters.some((cluster) => cluster.name === props.name))
    return undefined;
  const detailed = await run(
    "k3d",
    ["cluster", "list", props.name, "--token", "-o", "json"],
    { env },
  );
  return (JSON.parse(detailed.stdout) as K3dCluster[])[0];
};

export const parseK3sVersion = (output: string): string => {
  const match = /k3s version (v?\d+\.\d+\.\d+(?:[+-]k3s\d+)?)/.exec(output);
  if (match?.[1] === undefined)
    throw new Error(`Cannot determine K3s version from ${output.trim()}`);
  const version = match[1].replace("-k3s", "+k3s");
  return version.startsWith("v") ? version : `v${version}`;
};

export const runningVersion = async (
  props: ClusterStateProps,
  cluster: K3dCluster,
): Promise<string> => {
  const server = cluster.nodes?.find((node) => node.role === "server");
  if (server === undefined)
    throw new Error(`k3d cluster ${props.name} has no server node`);
  const result = await run(
    "docker",
    ["exec", server.name, "k3s", "--version"],
    {
      env: await dockerEnvironment(props.context),
    },
  );
  return parseK3sVersion(result.stdout);
};

export const createK3dCluster = async (
  props: ClusterStateProps,
  version: string,
  token?: string,
): Promise<void> => {
  await run("k3d", buildCreateArgs(props, version, token), {
    env: await dockerEnvironment(props.context),
    timeout: 15 * 60_000,
  });
};

export const deleteK3dCluster = async (
  props: ClusterStateProps,
): Promise<void> => {
  await run("k3d", ["cluster", "delete", props.name], {
    env: await dockerEnvironment(props.context),
    timeout: 10 * 60_000,
  });
};

export const getKubeconfig = async (
  props: ClusterStateProps,
): Promise<string> =>
  (
    await run("k3d", ["kubeconfig", "get", props.name], {
      env: await dockerEnvironment(props.context),
    })
  ).stdout;
