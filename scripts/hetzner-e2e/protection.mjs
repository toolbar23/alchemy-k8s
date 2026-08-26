import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("protection", process.argv.slice(2));
