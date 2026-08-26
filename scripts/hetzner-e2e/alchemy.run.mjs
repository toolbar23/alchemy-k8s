import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as HetznerK3s from "alchemy-hetzner-k3s";
import process from "node:process";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import { postgresState } from "alchemy/State/PostgresState";

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
if (config.recovery !== undefined) {
  for (const name of [
    "HETZNER_E2E_STATE_DATABASE_URL",
    "HETZNER_E2E_S3_ENDPOINT",
    "HETZNER_E2E_S3_REGION",
    "HETZNER_E2E_S3_BUCKET",
    "HETZNER_E2E_S3_ACCESS_KEY_ID",
    "HETZNER_E2E_S3_SECRET_ACCESS_KEY",
  ]) {
    if (!process.env[name]?.trim())
      throw new Error(`Set ${name} for recovery E2E`);
  }
}

export default Alchemy.Stack(
  "HetznerK3sE2E",
  {
    providers: Layer.mergeAll(Hetzner.providers(), HetznerK3s.providers()),
    state:
      config.recovery === undefined
        ? Alchemy.localState()
        : postgresState({
            url: Config.redacted("HETZNER_E2E_STATE_DATABASE_URL"),
          }),
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
      ...(config.recovery === undefined
        ? {}
        : { state: { encryptionAtRestConfirmed: true } }),
      ssh: { allowedCidrs: config.allowedCidrs },
      scheduleWorkloadsOnControlPlane: config.scheduleWorkloadsOnControlPlane,
      protectAgainstDeletion: config.protected,
      ...(config.etcdSnapshots === undefined
        ? {}
        : {
            etcdSnapshots: {
              ...config.etcdSnapshots,
              s3: {
                endpoint: process.env.HETZNER_E2E_S3_ENDPOINT,
                region: process.env.HETZNER_E2E_S3_REGION,
                bucket: process.env.HETZNER_E2E_S3_BUCKET,
                accessKeyId: process.env.HETZNER_E2E_S3_ACCESS_KEY_ID,
                secretAccessKey: Redacted.make(
                  process.env.HETZNER_E2E_S3_SECRET_ACCESS_KEY,
                ),
                ...(process.env.HETZNER_E2E_S3_SESSION_TOKEN === undefined
                  ? {}
                  : {
                      sessionToken: Redacted.make(
                        process.env.HETZNER_E2E_S3_SESSION_TOKEN,
                      ),
                    }),
                forcePathStyle:
                  process.env.HETZNER_E2E_S3_FORCE_PATH_STYLE === "true",
              },
            },
          }),
      ...(config.recovery === undefined ? {} : { recovery: config.recovery }),
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
