import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const kubeconfigPath = (
  provider: "hetzner" | "docker",
  fqn: string,
): string => {
  const safe = fqn.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
  return resolve(join(".alchemy", "kubeconfigs", provider, `${safe}.yaml`));
};

export const writeKubeconfig = async (
  path: string,
  contents: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
};
