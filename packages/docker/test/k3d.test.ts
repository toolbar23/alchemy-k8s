import { describe, expect, it } from "vitest";
import { normalizeK3sDefinition } from "../../shared/src/definition.ts";
import { buildCreateArgs, parseK3sVersion } from "../src/k3d.ts";
import type { ClusterStateProps } from "../src/types.ts";

const props: ClusterStateProps = {
  name: "local",
  k3s: normalizeK3sDefinition({
    channel: "v1.35",
    updateWindow: {
      days: ["Monday"],
      startTime: "09:00",
      endTime: "10:00",
      timeZone: "UTC",
    },
    addons: { traefik: false },
  }),
  apiPort: 6445,
  ports: [{ hostPort: 8080, containerPort: 80 }],
  volume: { name: "persistent-k3s-data" },
  configFingerprint: "test",
};

describe("k3d adapter", () => {
  it("creates one server without touching the user's default kubeconfig", () => {
    expect(buildCreateArgs(props, "v1.35.2+k3s1", "persistent-token")).toEqual(
      expect.arrayContaining([
        "--servers",
        "1",
        "--agents",
        "0",
        "rancher/k3s:v1.35.2-k3s1",
        "--token",
        "persistent-token",
        "--kubeconfig-update-default=false",
        "--kubeconfig-switch-context=false",
        "persistent-k3s-data:/var/lib/rancher/k3s@server:0",
        "8080:80/tcp@loadbalancer",
        "--disable=traefik@server:0",
        "--flannel-backend=vxlan@server:0",
      ]),
    );
  });

  it("normalizes the exact version reported by the running K3s binary", () => {
    expect(parseK3sVersion("k3s version v1.35.2+k3s1 (abcdef01)\n")).toBe(
      "v1.35.2+k3s1",
    );
  });
});
