import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("benchmark", process.argv.slice(2));
