import { expect, it } from "vitest";
import { resolveChannelVersion } from "../src/channel.ts";

it("resolves the exact patch from a pinned minor redirect", async () => {
  const fetcher = async () =>
    ({
      ok: true,
      status: 200,
      url: "https://github.com/k3s-io/k3s/releases/tag/v1.35.2%2Bk3s1",
      text: async () => "",
    }) as Response;
  await expect(
    resolveChannelVersion("v1.35", fetcher as typeof fetch),
  ).resolves.toBe("v1.35.2+k3s1");
});
