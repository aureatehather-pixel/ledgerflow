/**
 * Session policy — one source of truth, so configuration and tests cannot drift.
 *
 * The two limits are enforced by different mechanisms on purpose:
 *
 *   SLIDING INACTIVITY (30 min) is Better Auth's own expiry. `expiresIn` sets
 *   the window and `updateAge: 0` makes every authenticated request push
 *   `expires_at` forward. Leave a session untouched for 30 minutes and it dies.
 *
 *   ABSOLUTE MAXIMUM (8 h) is NOT a Better Auth feature. Better Auth has no
 *   absolute cap: its refresh is rolling, so on its own a session in continuous
 *   use would live forever. The cap is enforced in the canonical helper
 *   (lib/auth/session.ts) against `sessions.created_at`, which never moves.
 *
 * Rolling expiry is not an absolute timeout. Do not describe it as one.
 */

/**
 * Better Auth `session.expiresIn`, in seconds.
 *
 * UNIFORM ACROSS ROLES, DELIBERATELY. `os/domain/auth.md` prescribes a shorter
 * 15-minute idle window for administrative sessions and 30 minutes for standard
 * users. M1 applies 30 minutes to everyone, including partners, for two reasons:
 *
 *   - LedgerFlow has no administrative-session mode. `firm_role` distinguishes
 *     who may grant client assignments; it does not create a separate elevated
 *     session with its own risk profile, which is what a shorter admin window
 *     is designed to bound.
 *   - There is no project evidence for role-based idle expiry. Nobody has used
 *     the system yet, so a partner-specific window would be a guess about a
 *     risk we have not observed, traded against interrupting the person most
 *     likely to be mid-task.
 *
 * The 8-hour absolute cap applies to every role and is not relaxed anywhere.
 * Revisit if M5 introduces genuinely elevated operations (bulk export, firm-wide
 * configuration) that warrant their own session semantics.
 */
export const SESSION_IDLE_SECONDS = 30 * 60;

/** Better Auth `session.updateAge`, in seconds. Zero = refresh on every request,
 *  which is what turns rolling expiry into a genuine inactivity window. */
export const SESSION_UPDATE_AGE_SECONDS = 0;

/** Absolute ceiling measured from `sessions.created_at`, in milliseconds. */
export const SESSION_ABSOLUTE_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * Cookie caching is a SECURITY INVARIANT, not a performance setting.
 *
 * Better Auth can serve session data from a signed cookie without reading the
 * database. With it on, a revoked or expired session keeps working until the
 * cookie's own cache window lapses -- so deactivating a user would not take
 * effect on their next request, which is the entire reason this project uses
 * database sessions. There is a test asserting this stays false.
 */
export const COOKIE_CACHE_ENABLED = false;
