# alchemy-hetzner-k3s

Production-oriented Hetzner K3s clusters that implement Alchemy's
`Kubernetes.ClusterLike` contract.

See the
[repository documentation](https://github.com/toolbar23/alchemy-k8s#hetzner-cluster)
for configuration, Secret encryption migration and recovery, encrypted state
requirements, Kubernetes Secret handling, upgrades, and deletion details.

The current machine lifecycle is greenfield and intentionally has no adoption or
state-migration path from the `Hetzner.Server`-backed 0.1.0-alpha.4 release.
Destroy those experimental clusters before deploying this version. The
repository documentation describes the stable-name/generation transaction model
and crash-convergence tests.

The provider supplies Hetzner provider IDs to kubelets before registration,
waits for Nodes to register and become Ready, resolves K3s channels without
following redirects to GitHub, and keeps the public Kubernetes connection
available to downstream resources during mutable updates. Bundled Traefik uses a
K3s `HelmChartConfig` that prevents HCCM from publishing its private ingress
address while retaining private load-balancer targets.
