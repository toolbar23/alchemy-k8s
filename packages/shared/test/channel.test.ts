import { afterEach, expect, it, vi } from "vitest";
import { resolveChannelVersion } from "../src/channel.ts";

afterEach(() => vi.useRealTimers());

it("resolves the exact patch without following the channel redirect", async () => {
  const fetcher = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://github.com/k3s-io/k3s/releases/tag/v1.35.2%2Bk3s1",
        },
      });
    },
  );
  await expect(
    resolveChannelVersion("v1.35", fetcher as typeof fetch),
  ).resolves.toBe("v1.35.2+k3s1");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retries transient channel-service failures with bounded backoff", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("network unavailable"))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "/k3s-io/k3s/releases/tag/v1.35.3+k3s1" },
      }),
    );

  const resolution = resolveChannelVersion("v1.35", fetcher);
  await vi.advanceTimersByTimeAsync(250);

  await expect(resolution).resolves.toBe("v1.35.3+k3s1");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
