import type { NormalizedK3sDefinition } from "../../shared/src/types.ts";

export const CSI_VERSION = "v2.22.1";
export const SYSTEM_UPGRADE_CONTROLLER_VERSION = "v0.20.1";

export const hccmManifest = (channel: `v1.${number}`): string =>
  `https://github.com/hetznercloud/hcloud-cloud-controller-manager/releases/download/${channel}.0/ccm-networks.yaml`;
export const CSI_MANIFEST = `https://raw.githubusercontent.com/hetznercloud/csi-driver/${CSI_VERSION}/deploy/kubernetes/hcloud-csi.yml`;
export const SYSTEM_UPGRADE_CONTROLLER_MANIFEST = `https://github.com/rancher/system-upgrade-controller/releases/download/${SYSTEM_UPGRADE_CONTROLLER_VERSION}/system-upgrade-controller.yaml`;

const planWindow = (k3s: NormalizedK3sDefinition): string => {
  const days = k3s.updateWindow.days.map((day) =>
    day.slice(0, 3).toLowerCase(),
  );
  return [
    "  window:",
    `    days: [${days.join(", ")}]`,
    `    startTime: ${JSON.stringify(k3s.updateWindow.startTime)}`,
    `    endTime: ${JSON.stringify(k3s.updateWindow.endTime)}`,
    `    timeZone: ${JSON.stringify(k3s.updateWindow.timeZone)}`,
  ].join("\n");
};

export const systemUpgradePlans = (
  k3s: NormalizedK3sDefinition,
): string => `apiVersion: upgrade.cattle.io/v1
kind: Plan
metadata:
  name: k3s-server
  namespace: system-upgrade
spec:
  concurrency: 1
  cordon: true
  serviceAccountName: system-upgrade
  channel: https://update.k3s.io/v1-release/channels/${k3s.channel}
${planWindow(k3s)}
  nodeSelector:
    matchExpressions:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
  upgrade:
    image: rancher/k3s-upgrade
---
apiVersion: upgrade.cattle.io/v1
kind: Plan
metadata:
  name: k3s-agent
  namespace: system-upgrade
spec:
  concurrency: 1
  cordon: true
  serviceAccountName: system-upgrade
  channel: https://update.k3s.io/v1-release/channels/${k3s.channel}
${planWindow(k3s)}
  nodeSelector:
    matchExpressions:
      - key: node-role.kubernetes.io/control-plane
        operator: DoesNotExist
  prepare:
    image: rancher/k3s-upgrade
    args: ["prepare", "k3s-server"]
  upgrade:
    image: rancher/k3s-upgrade
`;
