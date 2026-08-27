import console from "node:console";
import process from "node:process";
import { runLifecycle } from "./harness.mjs";

const kubeconfig = process.env.KUBERNETES_API_E2E_KUBECONFIG;
const stage = process.env.KUBERNETES_API_E2E_STAGE ?? "manual";
if (kubeconfig === undefined) {
  throw new Error("KUBERNETES_API_E2E_KUBECONFIG is required");
}

console.log(
  JSON.stringify(
    runLifecycle({
      kubeconfig,
      stage,
      version: process.env.KUBERNETES_API_E2E_VERSION ?? "external",
    }),
    null,
    2,
  ),
);
