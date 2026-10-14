import { eq } from "drizzle-orm";

import { sessions, users } from "@/lib/db/schema";

import type { Auth } from "./index";
import { SESSION_ABSOLUTE_MAX_MS } from "./policy";

/**
 * The authenticated actor, resolved server-side. Everything downstream reads
 * identity from this and never from a request parameter.
 *
 * `firmId` is included because it is stored user state, not a client claim.
 * It is NOT authorization: commit 4 decides what this actor may touch, using
 * `client_assignments`. Firm membership alone grants nothing.
 */
export interface AuthenticatedActor {
  readonly userId: string;
  readonly firmId: string;
  readonly email: string;
  readonly firmRole: "partner" | "manager" | "staff";
  readonly sessionId: string;
  /** Immutable session start. The absolute cap is measured from this. */
  readonly sessionCreatedAt: Date;
}

export interface AuthContext {
  auth: Auth;
  // Drizzle's inferred database type is large and version-specific; the helper
  // only needs select/update/delete, which every variant provides.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  headers: Headers;
  /** Injectable for deterministic boundary tests. Defaults to server time. */
  now?: () => Date;
}

/**
 * THE canonical authenticated-request helper.
 *
 * Every protected entry point resolves its actor here, so session lifecycle
 * lives in exactly one place. Commit 4's authorization boundary consumes this
 * and adds resource checks on top -- it does not re-derive session state.
 *
 * Order matters: each step is a reason to deny, and a later step never rescues
 * an earlier failure.
 *
 *   1. resolve the session from persistent storage (cookie cache is disabled,
 *      so this is always a database read);
 *   2. deny when it is missing, expired or revoked;
 *   3. deny when the user is deactivated or soft-deleted -- defence in depth
 *      behind the databaseHooks guard that stops such sessions being created;
 *   4. deny when the session is older than the absolute maximum, measured
 *      against the immutable `created_at`, and delete it on the way out;
 *   5. only then return a narrowly typed actor.
 *
 * Returns `null` for every denial. Callers must not distinguish between the
 * reasons -- the difference is an information leak.
 */
export async function getAuthenticatedActor(
  ctx: AuthContext,
): Promise<AuthenticatedActor | null> {
  const now = (ctx.now ?? (() => new Date()))();

  // 1 + 2. Better Auth reads the session row and rejects expired ones. With
  // cookieCache disabled this is a live database lookup on every call, which is
  // what makes revocation effective on the next request.
  const result = await ctx.auth.api.getSession({ headers: ctx.headers });
  if (!result?.session || !result.user) return null;

  const sessionId = result.session.id;

  // 3. Current user state, read fresh rather than trusted from the session
  // payload -- a user deactivated mid-session must not survive on stale data.
  const userRows = await ctx.db
    .select({
      id: users.id,
      firmId: users.firmId,
      email: users.email,
      firmRole: users.firmRole,
      deactivatedAt: users.deactivatedAt,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, result.session.userId))
    .limit(1);

  const user = userRows[0];
  if (!user || user.deactivatedAt !== null || user.deletedAt !== null) {
    return null;
  }

  // 4. Absolute cap. Better Auth's own expiry slides forward on activity, so
  // without this a continuously used session would never end. `created_at` is
  // never updated, which is precisely why it is the right column to measure.
  const sessionRows = await ctx.db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  const sessionRow = sessionRows[0];
  if (!sessionRow) return null;

  const ageMs = now.getTime() - sessionRow.createdAt.getTime();
  if (ageMs >= SESSION_ABSOLUTE_MAX_MS) {
    // Delete rather than merely deny: a session past its absolute maximum is
    // finished, and leaving it behind invites a later code path to accept it.
    await ctx.db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }

  // 5.
  return {
    userId: user.id,
    firmId: user.firmId,
    email: user.email,
    firmRole: user.firmRole,
    sessionId,
    sessionCreatedAt: sessionRow.createdAt,
  };
}
