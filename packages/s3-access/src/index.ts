import type * as Redacted from "effect/Redacted";

/** Provider-issued access to exactly one S3-compatible bucket. */
export interface S3BucketAccess {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
  sessionToken?: Redacted.Redacted<string>;
  forcePathStyle?: boolean;
}
