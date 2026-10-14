import {
  AUDIT_ACTIONS,
  AUDIT_DENIAL_REASONS,
  AuditWriteError,
  auditableId,
  recordAuditEvent,
} from "@/lib/audit";
import type { AuthenticatedActor } from "@/lib/auth/session";

import { grantClientAccess, type AssignmentRequest } from "./clients";
import { findReadableDocument, type AuthorizedDocument } from "./documents";

/**
 * Audited access-controlled operations.
 *
 * The layer between the request boundary and the authorization primitives. It
 * orchestrates three things and implements none of them:
 *
 *   1. call the canonical primitive -- `findReadableDocument`,
 *      `grantClientAccess` -- which remains the sole authority on who may do
 *      what, and remains side-effect-free;
 *   2. record the allowed or denied outcome;
 *   3. return data only once the audit row is durable.
 *
 * Nothing here re-derives firm membership, client ownership, assignment state
 * or actor identity. There is no second authorization path to keep in agreement
 * with the first, and no session state is interpreted -- the actor arrives
 * already resolved by `getAuthenticatedActor`.
 *
 * **Why this is not in the Server Action.** The boundary in `app/actions/`
 * cannot be driven under test: it reads `next/headers`. An audit obligation
 * verified only by reading the code is verified by inference, which is the one
 * thing `CLAUDE.md` § Verification forbids. Putting the orchestration here makes A7 and A8
 * provable against a real database, and leaves the action a thin adapter.
 *
 * **Fail closed, and closed the same way on both paths.** If the audit write
 * fails, no protected data is returned. The audit row is attempted on the
 * allowed *and* the denied path, so an audit failure looks identical either
 * way -- which is what stops `AUDIT_UNAVAILABLE` from becoming a signal that
 * the document exists and the caller may see it.
 */

/** Distinct from a denial on purpose: an infrastructure failure is not a
 *  statement about the caller's access, and must never be logged or reported
 *  as one. Both withhold the document. */
export type ReadDocumentResult =
  | { ok: true; document: AuthorizedDocument }
  | { ok: false; error: "DENIED" }
  | { ok: false; error: "AUDIT_UNAVAILABLE" };

export async function readDocumentForActor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  documentId: string,
): Promise<ReadDocumentResult> {
  // The canonical primitive, unchanged and unwrapped. Its result IS the
  // authorization decision; nothing below re-examines it.
  const document = await findReadableDocument(db, actor, documentId);

  try {
    await recordAuditEvent(db, {
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      resourceType: "document",
      // Null for a malformed identifier: the log records the attempt, not the
      // garbage that was sent.
      resourceId: auditableId(documentId),
      outcome: document ? "allowed" : "denied",
      detail: document
        ? { clientId: document.clientId }
        : { reason: AUDIT_DENIAL_REASONS.NOT_READABLE },
    });
  } catch (error) {
    // Only infrastructure failures become an outcome. An `AuditDetailError` is
    // a programmer error and keeps propagating.
    if (!(error instanceof AuditWriteError)) throw error;
    return { ok: false, error: "AUDIT_UNAVAILABLE" };
  }

  return document
    ? { ok: true, document }
    : { ok: false, error: "DENIED" };
}

export type GrantAccessResult =
  | { ok: true }
  | { ok: false; error: "DENIED" }
  | { ok: false; error: "AUDIT_UNAVAILABLE" };

/**
 * Grants client access, audited atomically.
 *
 * The assignment row and its audit row are written in one transaction, so the
 * pair cannot come apart: an audit failure rolls the grant back, and a granted
 * assignment always has an event behind it. A refusal commits its own event and
 * nothing else.
 */
export async function grantClientAccessForActor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  request: AssignmentRequest,
): Promise<GrantAccessResult> {
  try {
    const granted: boolean = await db.transaction(
      async (tx: typeof db): Promise<boolean> => {
        const result = await grantClientAccess(tx, actor, request);

        await recordAuditEvent(tx, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.CLIENT_ACCESS_GRANT,
          resourceType: "client",
          resourceId: auditableId(request.clientId),
          outcome: result ? "allowed" : "denied",
          detail: grantDetail(request, result),
        });

        return result;
      },
    );

    return granted ? { ok: true } : { ok: false, error: "DENIED" };
  } catch (error) {
    if (!(error instanceof AuditWriteError)) throw error;
    return { ok: false, error: "AUDIT_UNAVAILABLE" };
  }
}

/**
 * Builds the grant event's detail from validated values only.
 *
 * `targetUserId` is admitted only if it is shaped like a UUID and
 * `accessLevel` only if it is one of the two known levels -- both arrive from
 * the caller, and an audit log that stores whatever a caller sent is an
 * injection surface rather than evidence.
 */
function grantDetail(
  request: AssignmentRequest,
  granted: boolean,
): Record<string, string> {
  const detail: Record<string, string> = {};

  const targetUserId = auditableId(request.userId);
  if (targetUserId) detail.targetUserId = targetUserId;

  if (request.accessLevel === "read" || request.accessLevel === "write") {
    detail.accessLevel = request.accessLevel;
  }

  if (!granted) detail.reason = AUDIT_DENIAL_REASONS.GRANT_REFUSED;

  return detail;
}
