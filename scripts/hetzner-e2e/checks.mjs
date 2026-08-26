import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("checks", process.argv.slice(2));
