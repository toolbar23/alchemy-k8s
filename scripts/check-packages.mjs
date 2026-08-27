import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packages = [
  "packages/hetzner",
  "packages/docker",
  "packages/kubernetes-api",
  "packages/kubernetes-addons",
  "packages/s3-access",
];
const versions = new Set();
const publishWorkflow = readFileSync(".github/workflows/publish.yml", "utf8");

if (!publishWorkflow.includes("id-token: write"))
  throw new Error("OIDC publishing requires id-token: write");
if (
  publishWorkflow.includes("registry-url:") ||
  publishWorkflow.includes("NODE_AUTH_TOKEN") ||
  publishWorkflow.includes("_authToken")
) {
  throw new Error(
    "OIDC publishing must not configure classic npm authentication",
  );
}

for (const directory of packages) {
  const manifest = JSON.parse(
    readFileSync(`${directory}/package.json`, "utf8"),
  );
  versions.add(manifest.version);
  const packOutput = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--dry-run", "--ignore-scripts", "--json", `./${directory}`],
      {
        encoding: "utf8",
      },
    ),
  );
  const result = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput[manifest.name];
  if (result === undefined)
    throw new Error(`${manifest.name} was missing from npm pack output`);
  const names = new Set(result.files.map((file) => file.path));
  for (const required of [
    "package.json",
    "LICENSE",
    "dist/index.mjs",
    "dist/index.d.mts",
  ]) {
    if (!names.has(required))
      throw new Error(`${manifest.name} package is missing ${required}`);
  }
  if (
    [...names].some((name) => name.startsWith("src/") || name.includes("test/"))
  ) {
    throw new Error(`${manifest.name} publishes source or tests unexpectedly`);
  }
}

if (versions.size !== 1)
  throw new Error("Public packages must use the same release version");
