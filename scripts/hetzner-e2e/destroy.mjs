import { runNamedPhase } from "./suite.mjs";
import process from "node:process";

await runNamedPhase("destroy", process.argv.slice(2));
