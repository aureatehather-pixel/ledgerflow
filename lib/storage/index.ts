/**
 * Object storage port.
 *
 * Two methods, because two are all the upload path uses: write the bytes, and
 * remove them when finalisation fails. It is not a general storage abstraction
 * and should not grow into one.
 *
 * Two implementations: `memory.ts`, injected by tests and never selected by
 * environment, and `r2.ts`, the Cloudflare R2 adapter, built on `aws4fetch`
 * rather than the AWS SDK. `select.ts` picks R2 from the environment and fails
 * closed when any variable is missing (`docs/SETUP.md` §2).
 */
export interface ObjectStore {
  /** Writes bytes at `key`. Overwrites are not expected: keys are unique. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Best-effort removal. Used only to compensate a failed finalisation. */
  delete(key: string): Promise<void>;
}

/**
 * Builds the storage key for a document.
 *
 * Every segment is a server-generated UUID. The original filename never appears
 * here — it is metadata, stored in a column, and interpolating it would let a
 * caller shape the path. Because nothing caller-controlled reaches this string,
 * a key cannot traverse out of its tenant prefix by construction rather than by
 * sanitisation.
 */
export function documentStorageKey(input: {
  firmId: string;
  clientId: string;
  documentId: string;
}): string {
  return `firms/${input.firmId}/clients/${input.clientId}/documents/${input.documentId}`;
}
