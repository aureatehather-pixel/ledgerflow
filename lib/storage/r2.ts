import { AwsClient } from "aws4fetch";

import type { ObjectStore } from "./index";

/**
 * Cloudflare R2 adapter.
 *
 * The only place in the codebase that knows R2 exists. `aws4fetch` types never
 * leave this file: everything upstream sees the two-method `ObjectStore` port.
 *
 * Scope is deliberately two operations. No multipart upload, no presigned URLs,
 * no transfer manager, no bucket administration — none of which commit 5 needs,
 * and each of which would be a surface to maintain and secure for no current
 * benefit.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * A storage failure, normalised.
 *
 * Carries the operation, the object key and the HTTP status — and nothing else.
 * Response bodies are deliberately excluded: S3-compatible error XML can echo
 * request parameters, and an error that gets logged is the wrong place to
 * discover that. Credentials, the Authorization header and the signed request
 * never reach this object.
 */
export class StorageError extends Error {
  constructor(
    readonly operation: "put" | "delete",
    readonly key: string,
    readonly status?: number,
  ) {
    super(
      `Storage ${operation} failed for "${key}"` +
        (status === undefined ? " (transport error)" : ` (HTTP ${status})`),
    );
    this.name = "StorageError";
  }
}

/** S3 PUT object answers 200; some gateways answer 201/204. */
const PUT_OK = new Set([200, 201, 204]);

/**
 * S3 DELETE object is idempotent: deleting an absent key answers 204, exactly
 * as deleting a present one does. That is precisely the behaviour compensation
 * wants, so an already-absent object counts as successful cleanup.
 *
 * There is deliberately no pre-delete existence check: it would cost a second
 * request and introduce a race between the check and the delete, to distinguish
 * a case the caller does not care about.
 */
const DELETE_OK = new Set([200, 202, 204, 404]);

export function createR2Store(
  config: R2Config,
  /** Injected so unit tests can assert the signed request without a network. */
  fetchImpl: typeof fetch = fetch,
): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;

  /** Keys are server-generated and already path-safe; each segment is a UUID.
   *  Encoded anyway so the adapter cannot be the weak link if that ever changes. */
  const urlFor = (key: string) =>
    `${endpoint}/${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function send(
    operation: "put" | "delete",
    key: string,
    init: RequestInit,
    accepted: Set<number>,
  ): Promise<void> {
    let response: Response;
    try {
      // Sign first, then hand the signed Request to the injected fetch. Signing
      // and sending are separate so the request is inspectable in tests without
      // reaching the network.
      const signed = await client.sign(urlFor(key), init);
      response = await fetchImpl(signed);
    } catch {
      // Transport failure. The cause is not attached: it can contain the
      // request, and therefore the Authorization header.
      throw new StorageError(operation, key);
    }
    if (!accepted.has(response.status)) {
      throw new StorageError(operation, key, response.status);
    }
  }

  return {
    async put(key, bytes, contentType) {
      await send(
        "put",
        key,
        {
          method: "PUT",
          // Copy into a fresh ArrayBuffer: BodyInit will not accept a
          // Uint8Array view over a SharedArrayBuffer, and slicing also avoids
          // sending more of a pooled buffer than intended.
          body: bytes.slice().buffer as ArrayBuffer,
          headers: { "content-type": contentType },
        },
        PUT_OK,
      );
    },

    async delete(key) {
      await send("delete", key, { method: "DELETE" }, DELETE_OK);
    },
  };
}
