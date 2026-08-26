import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { s3Footprint } from "./harness.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            ),
          ),
      ),
  );
});

describe("registry E2E S3 inventory", () => {
  it("signs ListObjectsV2 and totals the isolated registry prefix", async () => {
    let request;
    const server = createServer((incoming, response) => {
      request = incoming;
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        "<ListBucketResult>" +
          "<Contents><Key>registry-e2e/test/a</Key><Size>12</Size></Contents>" +
          "<Contents><Key>registry-e2e/test/b</Key><Size>30</Size></Contents>" +
          "<IsTruncated>false</IsTruncated>" +
          "</ListBucketResult>",
      );
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test S3 server did not expose a TCP port");
    }

    await expect(
      s3Footprint({
        s3: {
          endpoint: `http://127.0.0.1:${String(address.port)}`,
          region: "test-region",
          bucket: "test-bucket",
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
          sessionToken: "test-session-token",
          forcePathStyle: true,
          prefix: "registry-e2e/test",
        },
      }),
    ).resolves.toEqual({ objects: 2, bytes: 42 });
    expect(request?.url).toBe(
      "/test-bucket?list-type=2&prefix=registry-e2e%2Ftest",
    );
    expect(request?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-access-key\//,
    );
    expect(request?.headers["x-amz-security-token"]).toBe("test-session-token");
  });
});
