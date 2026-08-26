import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import { Credentials, providers } from "../src/index.ts";

it("loads Grafana deployment credentials without exposing the token", async () => {
  const credentials = await Effect.runPromise(
    Credentials.pipe(
      Effect.provide(providers()),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            GRAFANA_CLOUD_ACCESS_TOKEN: "grafana-canary-token",
            GRAFANA_CLOUD_ORG_SLUG: "example-org",
          },
        }),
      ),
    ),
  );
  expect(credentials.orgSlug).toBe("example-org");
  expect(Redacted.isRedacted(credentials.accessToken)).toBe(true);
  expect(JSON.stringify(credentials)).not.toContain("grafana-canary-token");

  await expect(
    Effect.runPromise(
      Credentials.pipe(
        Effect.provide(providers()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              GRAFANA_CLOUD_ACCESS_TOKEN: "",
              GRAFANA_CLOUD_ORG_SLUG: "example-org",
            },
          }),
        ),
      ),
    ),
  ).rejects.toThrow();
});
