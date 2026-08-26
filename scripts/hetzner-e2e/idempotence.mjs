import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("idempotence", process.argv.slice(2));
