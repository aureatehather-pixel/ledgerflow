import type { ObjectStore } from "./index";

/**
 * In-memory object store for tests.
 *
 * Can be told to fail its writes or its deletes, so the compensation paths are
 * exercised rather than assumed. A store that only ever succeeds would let every
 * failure-handling test pass without running any of it.
 */
export function memoryStore(options?: {
  failPut?: boolean;
  failDelete?: boolean;
}) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const store: ObjectStore & {
    objects: typeof objects;
    putCount: number;
    deleteCount: number;
  } = {
    objects,
    putCount: 0,
    deleteCount: 0,
    async put(key, bytes, contentType) {
      store.putCount += 1;
      if (options?.failPut) throw new Error("storage unavailable");
      objects.set(key, { bytes, contentType });
    },
    async delete(key) {
      store.deleteCount += 1;
      if (options?.failDelete) throw new Error("storage delete failed");
      objects.delete(key);
    },
  };
  return store;
}
