import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Relative to the directory Alchemy runs from. Alchemy identifies a cluster by
 * its connection's auth, which contains this path, so an absolute path would
 * make every checkout or workspace look like a different cluster and replace
 * everything deployed to it. Reading the cluster rewrites the file wherever
 * Alchemy runs.
 */
export const kubeconfigPath = (
  provider: "hetzner" | "docker",
  fqn: string,
): string => {
  const safe = fqn.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
  return join(".alchemy", "kubeconfigs", provider, `${safe}.yaml`);
};

export const writeKubeconfig = async (
  path: string,
  contents: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
};
