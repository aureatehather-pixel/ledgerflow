import { AwsClient } from "aws4fetch";

import type { R2Config } from "./r2";

/**
 * VERIFICATION-ONLY R2 reads.
 *
 * Not part of the `ObjectStore` port and not used by any application code: the
 * upload path needs `put` and `delete` and nothing else. These exist so the live
 * smoke test can prove an object really landed, and that cleanup really removed
 * it, without widening the production surface.
 *
 * Lives in `lib/storage` so provider-specific request construction stays in one
 * place, as the port's boundary rule requires.
 */

function clientFor(config: R2Config) {
  return new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

const endpointFor = (config: R2Config) =>
  `https://${config.accountId}.r2.cloudflarestorage.com`;

export interface ObjectMetadata {
  contentLength: number;
  contentType: string | null;
}

/** Metadata for one object, or `null` when absent. */
export async function headObject(
  config: R2Config,
  key: string,
): Promise<ObjectMetadata | null> {
  const url = `${endpointFor(config)}/${config.bucket}/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const signed = await clientFor(config).sign(url, { method: "HEAD" });
  const response = await fetch(signed);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`HEAD failed for "${key}" (HTTP ${response.status})`);
  }
  return {
    contentLength: Number(response.headers.get("content-length") ?? "0"),
    contentType: response.headers.get("content-type"),
  };
}

/**
 * Keys under a prefix. Used to prove the bucket is clean afterwards.
 *
 * Returns `null` when the token cannot list — R2's "Object Read & Write" does
 * not always include `ListBucket`, and a smoke test must not silently report
 * "zero objects" when what actually happened was "not permitted to look".
 */
export async function listObjectKeys(
  config: R2Config,
  prefix = "",
): Promise<string[] | null> {
  const url =
    `${endpointFor(config)}/${config.bucket}` +
    `?list-type=2&max-keys=1000${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;
  const signed = await clientFor(config).sign(url, { method: "GET" });
  const response = await fetch(signed);
  if (response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`LIST failed (HTTP ${response.status})`);
  }
  const xml = await response.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
}

export function r2ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): R2Config {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ] as const;
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Names only, never values.
    throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  }
  return {
    accountId: env["R2_ACCOUNT_ID"]!,
    accessKeyId: env["R2_ACCESS_KEY_ID"]!,
    secretAccessKey: env["R2_SECRET_ACCESS_KEY"]!,
    bucket: env["R2_BUCKET"]!,
  };
}
