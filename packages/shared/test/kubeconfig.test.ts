import { describe, expect, it } from "vitest";
import { kubeconfigPath } from "../src/kubeconfig.ts";

describe("generated kubeconfig location", () => {
  it("does not depend on the directory Alchemy runs from", () => {
    const fromHere = kubeconfigPath("hetzner", "openmdta-production/Openmdta");
    const previous = process.cwd();
    process.chdir("/");
    try {
      expect(kubeconfigPath("hetzner", "openmdta-production/Openmdta")).toBe(
        fromHere,
      );
    } finally {
      process.chdir(previous);
    }
    expect(fromHere).toBe(
      ".alchemy/kubeconfigs/hetzner/openmdta-production-Openmdta.yaml",
    );
  });
});
