import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("replace", process.argv.slice(2));
