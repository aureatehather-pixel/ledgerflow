import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull } from "drizzle-orm";

import { uuidv7 } from "@/lib/db/ids";
import * as schema from "@/lib/db/schema";
import { users } from "@/lib/db/schema";

import { hashPassword, verifyPassword } from "./password";
import {
  COOKIE_CACHE_ENABLED,
  SESSION_IDLE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "./policy";

/** Minimal shape we need from a Drizzle database, so tests can pass a
 *  PGlite-backed instance and production can pass a Neon one. */
type Database = Parameters<typeof drizzleAdapter>[0];

/**
 * Builds the Better Auth instance.
 *
 * A factory rather than a module-level singleton so tests can bind it to an
 * isolated in-process database. Production takes one instance (see `getAuth`).
 */
export function createAuth(db: Database, options?: { secret?: string }) {
  return betterAuth({
    // `usePlural` maps Better Auth's singular models (user, session, account,
    // verification) onto our plural tables. Its camelCase field names already
    // match our Drizzle property names, so no per-field mapping is needed --
    // Drizzle handles the snake_case column names underneath.
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
    }),

    secret: options?.secret ?? process.env["AUTH_SECRET"] ?? "",
    baseURL: process.env["AUTH_URL"] ?? "http://localhost:3000",

    advanced: {
      database: {
        // Our primary keys are uuid columns; Better Auth's default id generator
        // emits 32-char strings, which a uuid column rejects. Supplying uuidv7
        // keeps ids sortable and type-compatible with the rest of the schema.
        generateId: () => uuidv7(),
      },
    },

    emailAndPassword: {
      enabled: true,
      // M1 provisions users through a controlled server-side path. There is no
      // public sign-up, so the endpoint is closed rather than merely unlinked.
      disableSignUp: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },

    session: {
      // Sliding inactivity window. updateAge 0 means every authenticated request
      // pushes expires_at forward, so 30 minutes of silence ends the session.
      // This is NOT an absolute cap -- see lib/auth/session.ts for that.
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: {
        // Security invariant. Enabling this lets a session be read from a signed
        // cookie without a database lookup, so revocation would stop taking
        // effect on the next request. Asserted by a test.
        enabled: COOKIE_CACHE_ENABLED,
      },
    },

    databaseHooks: {
      session: {
        create: {
          /**
           * Refuse to mint a session for a user who is deactivated or
           * soft-deleted.
           *
           * This is Better Auth's documented `databaseHooks` extension point:
           * returning `false` from a `create.before` hook aborts the write
           * (verified in db/with-hooks.mjs). Nothing in Better Auth is patched
           * and there is no second credential-verification path.
           *
           * The same conditions are re-checked on every request in
           * lib/auth/session.ts -- this hook stops a session being created, the
           * helper stops an already-created one being used.
           */
          before: async (session) => {
            const rows = await db
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.id, session.userId as string),
                  isNull(users.deactivatedAt),
                  isNull(users.deletedAt),
                ),
              )
              .limit(1);
            if (rows.length === 0) return false;
            return undefined;
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
