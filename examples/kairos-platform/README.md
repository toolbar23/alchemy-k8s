# Kairos Cloudflare ingress

One shared Cloudflare tunnel for the existing Kairos cluster. This stack does
not manage nodes, Traefik, storage, media applications, Longhorn, backups, or
telemetry.

Every operation explicitly selects **`kairos` in `~/.kube/config`**, checks
**`https://192.168.178.85:6443`**, and verifies Ready node `kairos-60a7` at
`192.168.178.85`. Neither `KUBECONFIG` nor the current context can redirect it
to EKS. Alchemy's saved connection also pins the endpoint for deletion. A
replacement node/address requires deliberately updating the target constants and
tests.

## Setup

Use Node 22.18+, `npm ci --ignore-scripts`, then `npm run build`. Configure the
ignored root `.env`, or supply environment variables:

```dotenv
CLOUDFLARE_ACCOUNT_ID=<account owning openmdta.com>
CLOUDFLARE_API_TOKEN=<deployment token>
ACME_EMAIL=<exact email allowed into admin applications>
KAIROS_PUBLIC_HOSTS=test.openmdta.com
```

The deployment token needs Zone Read and DNS Read/Write for `openmdta.com`, plus
account-level Cloudflare Tunnel Write, API Tokens Write, Access Apps and
Policies Read/Write, and Access Organizations, Identity Providers, and Groups
Read/Write. The controller receives a separate token with only DNS and tunnel
permissions. Credentials stay out of Helm values and tracked files.

Enable Zero Trust/Access and its **One-time PIN** login method in Cloudflare.
The stack reuses this account configuration without taking ownership of it.
Bootstrap the encrypted Alchemy state backend if needed; its bootstrap requires
additional Workers and Secrets Store permissions. Kairos has an independent
state identity (`KairosPlatform`, stage `kairos`) and can share the account
state service.

```sh
# Only if the encrypted account state service needs bootstrapping:
node --env-file=.env node_modules/alchemy/bin/cli.js cloudflare bootstrap

node examples/kairos-platform/run.mjs preflight
node examples/kairos-platform/run.mjs plan --smoke
node examples/kairos-platform/run.mjs deploy --smoke
node examples/kairos-platform/run.mjs verify --smoke
```

The wrapper loads root `.env`; existing environment variables take precedence.
Preflight only reads Kubernetes and Cloudflare. It checks target, DNS ownership,
and Access setup; Alchemy plan/deploy checks write permissions and encrypted
state. The stack repeats preflight when invoked directly. There is no
local-state fallback.

The smoke route is `https://test.openmdta.com`. Its Access application is
created before ingress publication, allows only `ACME_EMAIL`, and uses 24-hour
sessions. Verification checks trusted HTTPS and the unauthenticated Access
redirect. Complete the email-code login manually and confirm the whoami response
to verify origin access.

```sh
node examples/kairos-platform/run.mjs cleanup
node examples/kairos-platform/run.mjs verify
```

Cleanup removes the smoke namespace/workload/ingress and waits for DNS cleanup.
The Access application remains to protect that hostname during removal and later
tests. Normal `deploy` runs without the smoke workload.

## Publishing applications

Use direct subdomains such as `app.openmdta.com`. No nested names or wildcards.
One tunnel routes all applications to ClusterIP Services; no router port
forwarding or LAN NodePorts are needed. Cloudflare supplies public HTTPS, and
the encrypted tunnel forwards HTTP inside the cluster. Traefik remains the
default ingress class.

STRRL v0.1.0 uses `_ctic_managed.<hostname>` TXT records for deletion ownership,
but **can overwrite an existing CNAME on creation**. Therefore:

1. Add a hostname to comma-separated `KAIROS_PUBLIC_HOSTS`, then plan/deploy.
   DNS preflight refuses conflicting records unless their CNAME and ownership
   TXT already belong to tunnel `kairos`.
2. For an admin application, create a Cloudflare Access application referencing
   the `Administrators` policy and OTP provider before publishing its ingress.
   Follow `SmokeAccess` and the dependency annotation in `alchemy.run.ts`.
   Hostname registration alone does not protect future apps with Access.
3. Create the application's Ingress with `ingressClassName: cloudflare-tunnel`.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
  namespace: your-app
spec:
  ingressClassName: cloudflare-tunnel
  rules:
    - host: app.openmdta.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: app
                port:
                  number: 8080
```

A fail-closed admission policy checks creation/updates and legacy annotations;
unregistered hostnames cannot be claimed. Preflight also checks existing
ingresses. Remove an ingress and wait for DNS cleanup before removing its
hostname from the allowlist. Do not repoint registered records outside this
controller: remove and unregister first. Concurrent external DNS edits cannot be
made atomic with ingress changes. Access protects the public route, not direct
LAN or cluster access.

## Rotation, validation, and removal

Token changes update the write-only Secret; its resource-version annotation
rolls the controller. Run `verify` afterward. Do not install ExternalDNS against
these same ingress hostnames.

Run `npm run check` and `npm run render:charts` after code changes. After
integrating a tested JJ revision, repeat `npm run build` in the main workspace
to refresh the ignored package artifacts imported by this stack.

Before uninstalling, remove all tunnel ingresses and wait for their CNAME and
TXT cleanup, then destroy only `KairosPlatform --stage kairos` with the same
guarded entrypoint. Do not destroy the shared account state backend. Kubernetes
garbage collection removes controller-owned connectors and tunnel credentials.
Upstream retains the Cloudflare tunnel; reinstalling the same name reuses it.
Delete that exact tunnel separately only when intentionally retiring it.

Backups are deferred; this stack provides no off-node backup for local-path
data.
