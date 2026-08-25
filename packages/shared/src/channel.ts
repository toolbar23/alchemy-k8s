import { validateChannel } from "./definition.ts";

export const resolveChannelVersion = async (
  channel: string,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  validateChannel(channel);
  const response = await fetcher(
    `https://update.k3s.io/v1-release/channels/${channel}`,
    {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Unable to resolve K3s channel ${channel}: HTTP ${response.status}`,
    );
  }
  const resolvedUrl = decodeURIComponent(response.url);
  const match = /(?:^|\/)(v\d+\.\d+\.\d+(?:\+k3s\d+)?)(?:$|[/?#])/.exec(
    resolvedUrl,
  );
  if (match?.[1] !== undefined) return match[1];
  const body = (await response.text()).trim();
  const bodyMatch = /v\d+\.\d+\.\d+(?:\+k3s\d+)?/.exec(body);
  if (bodyMatch?.[0] !== undefined) return bodyMatch[0];
  throw new Error(
    `K3s channel ${channel} returned no recognizable release version`,
  );
};
