import type { ObjectStore } from "./index";
import { createR2Store } from "./r2";

/**
 * Chooses the object store for the running environment.
 *
 * FAILS CLOSED. There is no in-memory fallback outside tests: silently storing
 * a firm's documents in a process that forgets them at restart is worse than
 * refusing to start. Production must be configured or must not run.
 *
 * Tests never reach this function: they inject `memoryStore()` explicitly, so
 * there is no path by which an in-memory store can be selected for a real
 * deployment.
 */
export function selectObjectStore(
  env: Record<string, string | undefined> = process.env,
): ObjectStore {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ] as const;

  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Names only. Never the values.
    throw new Error(
      `Object storage is not configured. Missing: ${missing.join(", ")}. ` +
        `There is no in-memory fallback outside tests.`,
    );
  }

  return createR2Store({
    accountId: env["R2_ACCOUNT_ID"]!,
    accessKeyId: env["R2_ACCESS_KEY_ID"]!,
    secretAccessKey: env["R2_SECRET_ACCESS_KEY"]!,
    bucket: env["R2_BUCKET"]!,
  });
}
