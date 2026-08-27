import { execFileSync, spawnSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";

const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter(
  (argument) => argument !== "--dry-run" && argument !== "--oidc",
);
if (unknownArguments.length > 0)
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`);

const dryRun = arguments_.includes("--dry-run");
const oidc = arguments_.includes("--oidc");
const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
const tag = rootManifest.version.includes("-") ? "next" : "latest";

for (const directory of rootManifest.workspaces) {
  const manifest = JSON.parse(
    readFileSync(`${directory}/package.json`, "utf8"),
  );
  if (manifest.private === true) continue;
  if (manifest.version !== rootManifest.version) {
    throw new Error(
      `${manifest.name}@${manifest.version} does not match workspace version ${rootManifest.version}`,
    );
  }

  const publishedVersion = spawnSync(
    "npm",
    ["view", `${manifest.name}@${manifest.version}`, "version"],
    { encoding: "utf8" },
  );
  if (publishedVersion.error !== undefined) throw publishedVersion.error;
  if (publishedVersion.status === 0) {
    console.log(
      `${manifest.name}@${manifest.version} is already published; skipping`,
    );
    continue;
  }
  const versionError = `${publishedVersion.stdout}${publishedVersion.stderr}`;
  if (!versionError.includes("E404")) {
    throw new Error(
      `Could not check ${manifest.name}@${manifest.version}:\n${versionError}`,
    );
  }

  if (!dryRun && !oidc) {
    const publishedPackage = spawnSync(
      "npm",
      ["view", manifest.name, "version"],
      { encoding: "utf8" },
    );
    if (publishedPackage.error !== undefined) throw publishedPackage.error;
    if (publishedPackage.status === 0) {
      throw new Error(
        `${manifest.name} already exists. Publish new versions through a GitHub Release and OIDC.`,
      );
    }
    const packageError = `${publishedPackage.stdout}${publishedPackage.stderr}`;
    if (!packageError.includes("E404")) {
      throw new Error(`Could not check ${manifest.name}:\n${packageError}`);
    }
  }

  console.log(
    `${dryRun ? "Previewing" : "Publishing"} ${manifest.name}@${manifest.version} with tag ${tag}`,
  );
  execFileSync(
    "npm",
    [
      "publish",
      `./${directory}`,
      "--access",
      "public",
      "--tag",
      tag,
      `--provenance=${oidc}`,
      ...(dryRun ? ["--dry-run"] : []),
    ],
    { stdio: "inherit" },
  );
}
