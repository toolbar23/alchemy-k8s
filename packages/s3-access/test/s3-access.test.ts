import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import type { S3BucketAccess } from "../src/index.ts";

it("describes provider-neutral S3 access with Redacted secrets", () => {
  const access = {
    endpoint: "https://s3.example.com",
    region: "eu-central-1",
    bucket: "cluster-backups",
    accessKeyId: "scoped-access-key",
    secretAccessKey: Redacted.make("secret"),
    sessionToken: Redacted.make("session"),
    forcePathStyle: true,
  } satisfies S3BucketAccess;

  expect(Redacted.isRedacted(access.secretAccessKey)).toBe(true);
  expect(Redacted.isRedacted(access.sessionToken)).toBe(true);
});
