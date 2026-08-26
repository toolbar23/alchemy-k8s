import { createPrivateKey, createPublicKey } from "node:crypto";
import * as Redacted from "effect/Redacted";

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

/** Full user-data document, so Alchemy's mutable Bun bootstrap is bypassed. */
export const hardenedCloudInit = (
  identity: { publicKey: string; privateKey: string },
  replacementToken?: string,
): string => `Content-Type: multipart/mixed; boundary="alchemy-k3s"
MIME-Version: 1.0

--alchemy-k3s
Content-Type: text/cloud-config; charset="utf-8"
MIME-Version: 1.0

#cloud-config
ssh_deletekeys: true
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
runcmd:
  - [/usr/sbin/sshd, -t]
  - [systemctl, restart, ssh]
final_message: "Alchemy K3s cloud-init complete${replacementToken === undefined ? "" : ` (${replacementToken})`}"
--alchemy-k3s--
`;
