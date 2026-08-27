import { validateChannel } from "./definition.ts";

export const resolveChannelVersion = async (
  channel: string,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  validateChannel(channel);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(
        `https://update.k3s.io/v1-release/channels/${channel}`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        },
      );
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400) {
        if (location === null) {
          throw new Error(`HTTP ${response.status} without a Location header`);
        }
        const match = /(?:^|\/)(v\d+\.\d+\.\d+(?:\+k3s\d+)?)(?:$|[/?#])/.exec(
          decodeURIComponent(location),
        );
        if (match?.[1] !== undefined) return match[1];
        throw new Error(
          `redirect contained no recognizable release version: ${location}`,
        );
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bodyMatch = /v\d+\.\d+\.\d+(?:\+k3s\d+)?/.exec(
        (await response.text()).trim(),
      );
      if (bodyMatch?.[0] !== undefined) return bodyMatch[0];
      throw new Error("response contained no recognizable release version");
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 1 ? 250 : 1_000),
        );
      }
    }
  }
  throw new Error(
    `Unable to resolve K3s channel ${channel} after 3 attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
};
