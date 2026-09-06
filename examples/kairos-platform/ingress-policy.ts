/** Admission applies to both modern and legacy class selection, including updates. */
export const kairosIngressPolicy = (hosts: string[]) => ({
  apiVersion: "admissionregistration.k8s.io/v1",
  kind: "ValidatingAdmissionPolicy",
  metadata: { name: "kairos-cloudflare-hostnames" },
  spec: {
    failurePolicy: "Fail",
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: ["networking.k8s.io"],
          apiVersions: ["v1"],
          operations: ["CREATE", "UPDATE"],
          resources: ["ingresses"],
        },
      ],
    },
    matchConditions: [
      {
        name: "cloudflare-class",
        expression:
          "(has(object.spec.ingressClassName) && object.spec.ingressClassName == 'cloudflare-tunnel') || (has(object.metadata.annotations) && 'kubernetes.io/ingress.class' in object.metadata.annotations && object.metadata.annotations['kubernetes.io/ingress.class'] == 'cloudflare-tunnel')",
      },
    ],
    validations: [
      {
        expression: `has(object.spec.ingressClassName) && object.spec.ingressClassName == 'cloudflare-tunnel' && has(object.spec.rules) && size(object.spec.rules) > 0 && object.spec.rules.all(r, has(r.host) && r.host in ${JSON.stringify(hosts)})`,
        message:
          "Use explicit cloudflare-tunnel ingressClassName and only DNS-preflight-approved KAIROS_PUBLIC_HOSTS",
      },
      {
        expression:
          "!has(object.metadata.annotations) || !('kubernetes.io/ingress.class' in object.metadata.annotations) || object.metadata.annotations['kubernetes.io/ingress.class'] == 'cloudflare-tunnel'",
        message: "Legacy ingress class must not conflict with ingressClassName",
      },
    ],
  },
});
