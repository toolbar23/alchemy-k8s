import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";

const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter(
  (argument) => argument !== "--dry-run",
);
if (unknownArguments.length > 0)
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`);

const dryRun = arguments_.includes("--dry-run");
const workingCopyChanges = execFileSync(
  "jj",
  ["diff", "--summary", "-r", "@"],
  { encoding: "utf8" },
).trim();
if (workingCopyChanges !== "") {
  throw new Error(
    "The JJ working copy must be empty. Finish the release revision and run jj new first.",
  );
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (typeof manifest.version !== "string" || manifest.version === "")
  throw new Error("package.json must contain a non-empty version");

const tag = `v${manifest.version}`;
const targetCommit = execFileSync(
  "jj",
  ["log", "--no-graph", "-r", "@-", "-T", "commit_id"],
  { encoding: "utf8" },
).trim();

execFileSync("jj", ["git", "fetch", "--remote", "origin"], {
  stdio: "inherit",
});
const remoteMainCommit = execFileSync(
  "jj",
  ["log", "--no-graph", "-r", "main@origin", "-T", "commit_id"],
  { encoding: "utf8" },
).trim();
const fastForwardTarget = execFileSync(
  "jj",
  [
    "log",
    "--no-graph",
    "-r",
    `${targetCommit} & ${remoteMainCommit}::`,
    "-T",
    "commit_id",
  ],
  { encoding: "utf8" },
).trim();
if (fastForwardTarget !== targetCommit) {
  throw new Error(
    `Release revision ${targetCommit} is not a descendant of main@origin (${remoteMainCommit})`,
  );
}

execFileSync("gh", ["auth", "status"], { stdio: "inherit" });
if (dryRun) {
  console.log(
    `Would push ${targetCommit} to main and create GitHub Release ${tag}`,
  );
  process.exit(0);
}

execFileSync("jj", ["bookmark", "set", "main", "-r", targetCommit], {
  stdio: "inherit",
});
execFileSync("jj", ["git", "push", "--bookmark", "main"], {
  stdio: "inherit",
});
execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    "--target",
    targetCommit,
    "--title",
    tag,
    "--generate-notes",
    ...(manifest.version.includes("-") ? ["--prerelease"] : []),
  ],
  { stdio: "inherit" },
);
