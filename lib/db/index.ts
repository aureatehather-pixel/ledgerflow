import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

let cached: ReturnType<typeof drizzle> | undefined;

/**
 * The production database handle, created on first use.
 *
 * Lazy rather than module-level so importing anything from this file does not
 * require DATABASE_URL to be set -- tests bind to PGlite instead and must never
 * touch a real connection string.
 */
export function getDb() {
  if (!cached) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      // Fail loud and early. A silent fallback to a default connection is how
      // a development database ends up serving production traffic.
      throw new Error("DATABASE_URL is not set");
    }
    cached = drizzle(neon(url), { schema });
  }
  return cached;
}
