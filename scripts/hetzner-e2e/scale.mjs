import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("scale", process.argv.slice(2));
