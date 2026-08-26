import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("preflight", process.argv.slice(2));
