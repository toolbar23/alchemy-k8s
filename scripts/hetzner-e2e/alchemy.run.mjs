import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as HetznerK3s from "alchemy-hetzner-k3s";
import process from "node:process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const encoded = process.env.HETZNER_E2E_CONFIG;
if (encoded === undefined) {
  throw new Error(
    "HETZNER_E2E_CONFIG is set by the manual suite; invoke an e2e:hetzner:* npm script instead of running this stack directly",
  );
}

const config = JSON.parse(encoded);
if (
  typeof config.profile !== "string" ||
  typeof config.resourceId !== "string" ||
  typeof config.channel !== "string" ||
  !Array.isArray(config.allowedCidrs) ||
  !Array.isArray(config.workerPools)
) {
  throw new Error("HETZNER_E2E_CONFIG has an invalid shape");
}

export default Alchemy.Stack(
  "HetznerK3sE2E",
  {
    providers: Layer.mergeAll(Hetzner.providers(), HetznerK3s.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const cluster = yield* HetznerK3s.Cluster(config.resourceId, {
      k3s: {
        channel: config.channel,
        updateWindow: {
          days: ["Sunday"],
          startTime: "02:00",
          endTime: "04:00",
          timeZone: "Europe/Berlin",
        },
        addons: { traefik: true, metricsServer: true },
      },
      controlPlane: config.controlPlane,
      workerPools: config.workerPools,
      ssh: { allowedCidrs: config.allowedCidrs },
      scheduleWorkloadsOnControlPlane: config.scheduleWorkloadsOnControlPlane,
      protectAgainstDeletion: config.protected,
    });

    return {
      profile: config.profile,
      channel: cluster.channel,
      endpoint: cluster.endpoint,
      kubeconfigPath: cluster.kubeconfigPath,
      currentVersions: cluster.currentVersions,
    };
  }),
);
