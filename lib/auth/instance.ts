import { getDb } from "@/lib/db";

import { createAuth, type Auth } from "./index";

let cached: Auth | undefined;

/** The production Better Auth instance, created on first use. */
export function getAuth(): Auth {
  cached ??= createAuth(getDb());
  return cached;
}
