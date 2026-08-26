import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export interface GrafanaCredentials {
  accessToken: Redacted.Redacted<string>;
  orgSlug: string;
}

export class Credentials extends Context.Service<
  Credentials,
  GrafanaCredentials
>()("alchemy-grafana/Credentials") {}

/** Resolve the deployment credential from the standard Grafana environment. */
export const providers = () => {
  const credentials = Config.all({
    accessToken: Config.map(
      Config.nonEmptyString("GRAFANA_CLOUD_ACCESS_TOKEN"),
      Redacted.make,
    ),
    orgSlug: Config.nonEmptyString("GRAFANA_CLOUD_ORG_SLUG"),
  });
  return Layer.effect(Credentials, credentials);
};
