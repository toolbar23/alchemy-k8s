import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("upgrade", process.argv.slice(2));
