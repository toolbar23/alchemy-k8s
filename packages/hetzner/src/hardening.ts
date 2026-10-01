import { createPrivateKey, createPublicKey } from "node:crypto";
import * as Redacted from "effect/Redacted";
import type { LocalDisks } from "./types.ts";

const uint32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
};

/** Derive a stable Ed25519 identity from an encrypted Alchemy random. */
export const sshIdentity = (
  seedValue: Redacted.Redacted<string> | string,
  comment: string,
): { publicKey: string; privateKey: string } => {
  const seedHex =
    typeof seedValue === "string" ? seedValue : Redacted.value(seedValue);
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("SSH seed must contain 32 bytes");
  const privateDer = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const privateObject = createPrivateKey({
    key: privateDer,
    format: "der",
    type: "pkcs8",
  });
  const publicDer = createPublicKey(privateObject).export({
    format: "der",
    type: "spki",
  });
  const publicRaw = publicDer.subarray(publicDer.length - 32);
  const algorithm = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([
    sshString(algorithm),
    sshString(publicRaw),
  ]);
  const publicKey = `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`;

  const check = Buffer.alloc(4);
  check.writeUInt32BE(0xa1b2c3d4);
  const secret = Buffer.concat([seed, publicRaw]);
  let inner = Buffer.concat([
    check,
    check,
    sshString(algorithm),
    sshString(publicRaw),
    sshString(secret),
    sshString(comment),
  ]);
  const paddingLength = (8 - (inner.length % 8)) % 8;
  const padding = Buffer.alloc(paddingLength);
  for (let index = 0; index < paddingLength; index += 1) {
    padding[index] = index + 1;
  }
  inner = Buffer.concat([inner, padding]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(inner),
  ]).toString("base64");
  const wrapped = body.match(/.{1,70}/g)?.join("\n") ?? body;
  return {
    publicKey,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
};

const indent = (value: string, spaces: number): string =>
  value
    .trimEnd()
    .split("\n")
    .map((line) => `${" ".repeat(spaces)}${line}`)
    .join("\n");

export const CONTAINERD_DIRECTORY = "/var/lib/rancher/k3s/agent/containerd";

/**
 * Runs from cloud-init before K3s is installed and is safe to repeat: it
 * shrinks nothing, keys every step on partition labels, and leaves an
 * existing volume group alone. K3s refuses to start without the containerd
 * mount, so images can never silently land on the root filesystem.
 */
export const LOCAL_DISKS_SCRIPT = `#!/bin/bash
set -euo pipefail
ROOT_SIZE=\${1:?root size}; CONTAINERD_SIZE=\${2:?containerd size}; VG=\${3:?volume group}
CONTAINERD_DIR=${CONTAINERD_DIRECTORY}
root_part=$(findmnt -no SOURCE /)
disk=/dev/$(lsblk -no PKNAME "$root_part")
root_num=$(cat "/sys/class/block/$(basename "$root_part")/partition")
if [ ! -e /dev/disk/by-partlabel/containerd ]; then
  sgdisk -e "$disk"
  echo ",$ROOT_SIZE" | sfdisk --no-reread --no-tell-kernel -N "$root_num" "$disk"
  sgdisk -n "0:0:+$CONTAINERD_SIZE" -t 0:8300 -c 0:containerd -n 0:0:0 -t 0:8e00 -c "0:$VG" "$disk"
  partx -u "$disk"
  udevadm settle
fi
resize2fs "$root_part"
[ "$(blkid -o value -s TYPE /dev/disk/by-partlabel/containerd)" = ext4 ] || mkfs.ext4 -q -L containerd /dev/disk/by-partlabel/containerd
grep -q " $CONTAINERD_DIR " /etc/fstab || echo "PARTLABEL=containerd $CONTAINERD_DIR ext4 defaults,noatime 0 2" >> /etc/fstab
mkdir -p "$CONTAINERD_DIR"
for unit in k3s k3s-agent; do
  mkdir -p "/etc/systemd/system/$unit.service.d"
  printf '[Unit]\\nRequiresMountsFor=%s\\n[Service]\\nExecStartPre=/usr/bin/mountpoint -q %s\\n' "$CONTAINERD_DIR" "$CONTAINERD_DIR" > "/etc/systemd/system/$unit.service.d/containerd-mount.conf"
done
systemctl daemon-reload
mountpoint -q "$CONTAINERD_DIR" || mount "$CONTAINERD_DIR"
vgs "$VG" >/dev/null 2>&1 || { pvcreate -y "/dev/disk/by-partlabel/$VG"; vgcreate "$VG" "/dev/disk/by-partlabel/$VG"; }
`;

/** Full user-data document, so Alchemy's mutable Bun bootstrap is bypassed. */
export const hardenedCloudInit = (
  identity: { publicKey: string; privateKey: string },
  replacementToken?: string,
  localDisks?: LocalDisks,
): string => `Content-Type: multipart/mixed; boundary="alchemy-k3s"
MIME-Version: 1.0

--alchemy-k3s
Content-Type: text/cloud-config; charset="utf-8"
MIME-Version: 1.0

#cloud-config
${localDisks === undefined ? "" : `growpart:\n  mode: "off"\nresize_rootfs: false\n`}ssh_deletekeys: true
ssh_keys:
  ed25519_private: |
${indent(identity.privateKey, 4)}
  ed25519_public: ${JSON.stringify(identity.publicKey)}
write_files:
  - path: /etc/ssh/sshd_config.d/99-alchemy-k3s.conf
    owner: root:root
    permissions: "0644"
    content: |
      HostKey /etc/ssh/ssh_host_ed25519_key
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      ChallengeResponseAuthentication no
      PermitEmptyPasswords no
      PermitRootLogin prohibit-password
      MaxAuthTries 3
      X11Forwarding no
      AllowAgentForwarding no
      AllowTcpForwarding no
      PermitTunnel no
${
  localDisks === undefined
    ? ""
    : `  - path: /usr/local/sbin/alchemy-k3s-local-disks
    owner: root:root
    permissions: "0755"
    content: |
${indent(LOCAL_DISKS_SCRIPT, 6)}
`
}runcmd:
  - [/usr/sbin/sshd, -t]
  - [systemctl, restart, ssh]
${
  localDisks === undefined
    ? ""
    : `  - [/usr/local/sbin/alchemy-k3s-local-disks, ${localDisks.rootGiB}G, ${localDisks.containerdGiB}G, ${JSON.stringify(localDisks.volumeGroup)}]\n`
}final_message: "Alchemy K3s cloud-init complete${replacementToken === undefined ? "" : ` (${replacementToken})`}"
--alchemy-k3s--
`;
