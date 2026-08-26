import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("all", process.argv.slice(2));
