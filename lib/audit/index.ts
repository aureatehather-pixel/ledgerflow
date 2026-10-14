import { auditEvents } from "@/lib/db/schema";
import { isUuid } from "@/lib/db/ids";

/**
 * The audit trail.
 *
 * One module, one job: append an `audit_events` row describing an
 * access-controlled operation and its outcome. It decides nothing about
 * authorization -- callers hand it a decision that has already been made by the
 * canonical primitives in `lib/authz/`.
 *
 * Two properties this module exists to hold:
 *
 *   1. **Only an authenticated actor is recorded.** Unauthenticated attempts
 *      terminate at `getAuthenticatedActor` and are deliberately not written
 *      here -- see `docs/decisions/0002-audit-authenticated-denials-only.md`.
 *      `actorUserId` is therefore required, even though the column is nullable
 *      for that decision's eventual reversal.
 *   2. **Nothing caller-controlled reaches the row.** `action`, `resourceType`,
 *      `outcome` and every denial reason are constants from this file. The only
 *      variable values are identifiers, and they are admitted only after passing
 *      a UUID shape check (`auditableId`). A caller cannot put a filename, a
 *      hash, document bytes, an exception message or a 10 KB string into the
 *      log, because there is no parameter that would carry one.
 */

export const AUDIT_ACTIONS = {
  /** A read of a single document through the request boundary. */
  DOCUMENT_READ: "document.read",
  /** A first-time document creation. */
  DOCUMENT_UPLOAD: "document.upload",
  /**
   * A re-submission of bytes already stored for the same client, which returns
   * the existing document instead of creating one. Distinct from
   * `DOCUMENT_UPLOAD` so the trail never implies a document was created twice.
   */
  DOCUMENT_UPLOAD_DEDUPLICATED: "document.upload_deduplicated",
  /** An attempt to widen who may see a client's records. */
  CLIENT_ACCESS_GRANT: "client_access.grant",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Denial reasons, as a closed set.
 *
 * These are internal: the caller is told nothing beyond an undifferentiated
 * refusal. Non-disclosure constrains what crosses the boundary, not what the
 * firm's own audit trail may hold -- a log that cannot say why access was
 * refused answers none of the questions an auditor asks.
 */
export const AUDIT_DENIAL_REASONS = {
  /** No readable document resolved: wrong firm, no assignment, not `ready`,
   *  soft-deleted, nonexistent or malformed. The primitive does not
   *  distinguish these, so neither does the log. */
  NOT_READABLE: "not_readable",
  /** No live write-level assignment to the target client at reserve time. */
  NO_WRITE_ASSIGNMENT: "no_write_assignment",
  /** The target client identifier was not shaped like a UUID, so it never
   *  reached the driver. The caller sees the same refusal as any other. */
  MALFORMED_CLIENT_ID: "malformed_client_id",
  /** Write access disappeared between reserving the row and finalising it. */
  REVOKED_BEFORE_FINALIZE: "revoked_before_finalize",
  /** The grant was refused: insufficient role, or a target user or client
   *  outside the actor's firm. `grantClientAccess` returns one boolean by
   *  design, so the log records the refusal without inventing a cause. */
  GRANT_REFUSED: "grant_refused",
} as const;

export type AuditDenialReason =
  (typeof AUDIT_DENIAL_REASONS)[keyof typeof AUDIT_DENIAL_REASONS];

export type AuditResourceType = "document" | "client";

export type AuditOutcome = "allowed" | "denied";

/**
 * Per-action allowlist of `detail` keys.
 *
 * An allowlist, not a blocklist (standards.md: default to deny). Anything not
 * named here cannot be written, so the categories that must never appear --
 * filenames, bytes, document contents, hashes, secrets, arbitrary caller
 * metadata -- are excluded by construction rather than by remembering.
 *
 * Filenames are the non-obvious one. Malaysian source documents routinely carry
 * a client's personal name in the filename, which would make the audit log a
 * second, unmanaged store of personal data.
 */
const DETAIL_ALLOWLIST: Record<AuditAction, readonly string[]> = {
  [AUDIT_ACTIONS.DOCUMENT_READ]: ["clientId", "reason"],
  [AUDIT_ACTIONS.DOCUMENT_UPLOAD]: ["clientId", "reason"],
  [AUDIT_ACTIONS.DOCUMENT_UPLOAD_DEDUPLICATED]: ["clientId"],
  [AUDIT_ACTIONS.CLIENT_ACCESS_GRANT]: ["targetUserId", "accessLevel", "reason"],
};

/** Exposed so tests can assert emitted rows against the same source the writer
 *  enforces, rather than a second copy that could drift out of agreement. */
export function allowedDetailKeys(action: AuditAction): readonly string[] {
  return DETAIL_ALLOWLIST[action];
}

/**
 * The audit write failed.
 *
 * A distinct type because the caller must be able to tell an infrastructure
 * failure from an authorization denial. Both withhold protected data; only one
 * of them means "you may not have this", and recording or reporting the other
 * as a denial would put a false statement in the trail.
 */
export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super("failed to append an audit event");
    this.name = "AuditWriteError";
    this.cause = cause;
  }
}

/**
 * Thrown when a caller offers a `detail` key outside the allowlist.
 *
 * A programmer error, not an operational one, so it is NOT an
 * `AuditWriteError` and is never converted into a typed outcome: it propagates
 * until something crashes (standards.md: programmer errors crash loudly). A
 * caller that catches infrastructure failures will re-throw this untouched.
 */
export class AuditDetailError extends Error {
  constructor(action: AuditAction, key: string) {
    super(`audit detail key "${key}" is not allowed for action "${action}"`);
    this.name = "AuditDetailError";
  }
}

export interface AuditEventInput {
  /** Required. Unauthenticated attempts are not audited -- see ADR 0002. */
  actorUserId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  /** `null` when the operation names no valid resource, e.g. a denial against
   *  a malformed identifier. Use `auditableId` to derive it. */
  resourceId: string | null;
  outcome: AuditOutcome;
  detail?: Readonly<Record<string, string>>;
}

/**
 * Admits an identifier into the log only if it is shaped like a UUID.
 *
 * Two reasons, and the second is the one that bites: a malformed string in a
 * `uuid` column raises a driver error, which would turn an ordinary denial into
 * an exception and hand the caller a distinguishable response. Returning `null`
 * keeps the denial's shape identical whatever the caller sent.
 */
export function auditableId(value: string | null | undefined): string | null {
  return typeof value === "string" && isUuid(value) ? value : null;
}

/**
 * Appends one event.
 *
 * Takes whatever executor it is given -- a database handle or a transaction.
 * Passing a transaction is what makes a write operation and its audit row
 * atomic, and callers that protect a write are expected to do exactly that.
 *
 * Throws `AuditWriteError` if the row cannot be written. It does not decide what
 * that means for the operation; the caller does, because only the caller knows
 * whether protected data is waiting to be returned.
 */
export async function recordAuditEvent(
  // Drizzle's inferred handle type is large, version-specific, and differs
  // between a database and a transaction. Only `.insert()` is used.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  event: AuditEventInput,
): Promise<void> {
  assertDetailAllowed(event.action, event.detail);

  try {
    await db.insert(auditEvents).values({
      actorUserId: event.actorUserId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      detail: event.detail ?? null,
    });
  } catch (cause) {
    // Loud on the way past: the operation's typed outcome tells the caller that
    // something failed, but only this carries what. `no-console` allows `error`
    // for exactly this until structured logging exists.
    console.error("audit_write_failed", {
      action: event.action,
      outcome: event.outcome,
      resourceType: event.resourceType,
      cause,
    });
    throw new AuditWriteError(cause);
  }
}

function assertDetailAllowed(
  action: AuditAction,
  detail: Readonly<Record<string, string>> | undefined,
): void {
  if (!detail) return;
  const allowed = DETAIL_ALLOWLIST[action];
  for (const key of Object.keys(detail)) {
    if (!allowed.includes(key)) throw new AuditDetailError(action, key);
  }
}
