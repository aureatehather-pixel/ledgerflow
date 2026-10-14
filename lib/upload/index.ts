import { createHash } from "node:crypto";

import { and, eq, exists, isNull } from "drizzle-orm";

import {
  AUDIT_ACTIONS,
  AUDIT_DENIAL_REASONS,
  AuditWriteError,
  recordAuditEvent,
  type AuditDenialReason,
} from "@/lib/audit";
import type { AuthenticatedActor } from "@/lib/auth/session";
import { clientAssignments, clients, documents } from "@/lib/db/schema";
import { isUuid, uuidv7 } from "@/lib/db/ids";
import { documentStorageKey, type ObjectStore } from "@/lib/storage";

import { validateUpload, type ValidationFailure } from "./validation";

/**
 * Document upload.
 *
 * PostgreSQL and object storage share no transaction, so the ordering is chosen
 * so that the *database always knows about every object*:
 *
 *   1. reserve  — authorize and INSERT a `pending` row, in one transaction. The
 *                 storage key is derived here from server-held ids.
 *   2. put      — write the bytes. On failure the row is marked `failed`; no
 *                 object exists, and nothing was ever visible.
 *   3. finalize — flip to `ready`, RE-CHECKING authorization inside the same
 *                 UPDATE. On failure the object is deleted and the row marked
 *                 `failed`.
 *
 * The reverse order (object first) would allow an object with no row — an
 * orphan nothing could ever find. This way the worst case is a row in `failed`
 * or `pending` whose key is known, which is recoverable by inspection.
 *
 * **Audit.** The authorization decision is recorded inside the reserve
 * transaction, so the document row and its event commit or roll back together:
 * a stored document always has an event behind it, and an audit failure leaves
 * no document. Denials are recorded for the same actor, which is what stops an
 * audit failure from being distinguishable between the allowed and denied
 * paths. Unauthenticated callers never reach here at all — see
 * `docs/decisions/0002-audit-authenticated-denials-only.md`.
 */

export type UploadOutcome =
  | { ok: true; documentId: string; deduplicated: boolean }
  /** Indistinguishable for foreign, unassigned, nonexistent and malformed
   *  clients, and for authorization revoked mid-upload. */
  | { ok: false; error: "DENIED" }
  /** Safe to differentiate: this describes the caller's own file and leaks
   *  nothing about other tenants. */
  | { ok: false; error: "INVALID"; reason: ValidationFailure }
  | { ok: false; error: "STORAGE_FAILED" }
  | { ok: false; error: "FINALIZATION_FAILED"; orphanObjectRemoved: boolean }
  /** The trail could not be written, so the operation did not happen. NOT a
   *  denial: nothing here is a statement about what the caller may do. */
  | { ok: false; error: "AUDIT_FAILED" };

const DENIED = { ok: false, error: "DENIED" } as const;
const AUDIT_FAILED = { ok: false, error: "AUDIT_FAILED" } as const;

export interface UploadDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  store: ObjectStore;
}

export interface UploadInput {
  clientId: string;
  filename: string;
  declaredType: string;
  bytes: Uint8Array;
}

/**
 * The live write-access predicate, as a subquery.
 *
 * Used inside the finalizing UPDATE so that authorization is revalidated in the
 * same statement that makes the document visible. Checking with
 * `canWriteToClient()` and then writing separately would leave a window in
 * which access is revoked between the two.
 */
function hasLiveWriteAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  clientId: string,
) {
  return exists(
    db
      .select({ one: clientAssignments.id })
      .from(clientAssignments)
      .innerJoin(
        clients,
        and(
          eq(clients.id, clientAssignments.clientId),
          // Tenant predicate. Explicit, not implied by the assignment.
          eq(clients.firmId, actor.firmId),
          isNull(clients.deletedAt),
        ),
      )
      .where(
        and(
          eq(clientAssignments.clientId, clientId),
          eq(clientAssignments.userId, actor.userId),
          eq(clientAssignments.accessLevel, "write"),
          isNull(clientAssignments.revokedAt),
        ),
      ),
  );
}

export async function uploadDocument(
  deps: UploadDeps,
  actor: AuthenticatedActor,
  input: UploadInput,
): Promise<UploadOutcome> {
  // Validate before any database access. A rejected file must not cost a query.
  //
  // Deliberately not audited: this is input validation, not an access-control
  // decision, so it is outside A7/A8 — and auditing it would let an
  // authenticated caller amplify writes with malformed files, the same abuse
  // vector ADR 0002 refuses for unauthenticated denials.
  const validation = validateUpload(input);
  if (!validation.ok) {
    return { ok: false, error: "INVALID", reason: validation.reason };
  }

  // Malformed ids never reach the driver: a driver error would be a
  // distinguishable response, and therefore an enumeration oracle. This IS an
  // authorization denial, so it is audited — outside a transaction, because
  // there is nothing to roll back.
  if (!isUuid(input.clientId)) {
    return auditUploadDenial(deps.db, actor, {
      reason: AUDIT_DENIAL_REASONS.MALFORMED_CLIENT_ID,
    });
  }

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  // --- 1. reserve ---------------------------------------------------------
  //
  // Every path out of this transaction writes exactly one audit event through
  // `tx`, so the event shares the document row's fate. A denial commits its
  // event and nothing else; an audit failure aborts the whole transaction and
  // leaves no reserved row for the storage step to find.
  let reserved: ReserveResult;
  try {
    reserved = await deps.db.transaction(
      async (tx: typeof deps.db): Promise<ReserveResult> => {
        // Authorization and tenancy resolved in one constrained query. `firmId`
        // comes from THIS row, never from the caller and never assumed from the
        // actor alone.
        const [client] = await tx
          .select({ id: clients.id, firmId: clients.firmId })
          .from(clients)
          .innerJoin(
            clientAssignments,
            and(
              eq(clientAssignments.clientId, clients.id),
              eq(clientAssignments.userId, actor.userId),
              eq(clientAssignments.accessLevel, "write"),
              isNull(clientAssignments.revokedAt),
            ),
          )
          .where(
            and(
              eq(clients.id, input.clientId),
              eq(clients.firmId, actor.firmId),
              isNull(clients.deletedAt),
            ),
          )
          .limit(1);

        if (!client) {
          await recordAuditEvent(tx, {
            actorUserId: actor.userId,
            action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
            resourceType: "document",
            // No document was ever named: the caller asked to create one.
            resourceId: null,
            outcome: "denied",
            // Safe to record: the id passed the shape check above, and the log
            // is where "who probed which client" has to be answerable.
            detail: {
              clientId: input.clientId,
              reason: AUDIT_DENIAL_REASONS.NO_WRITE_ASSIGNMENT,
            },
          });
          return { kind: "denied" };
        }

        // Retry idempotence: the same bytes for the same client are the same
        // document. A user re-submitting after a dropped connection gets the
        // existing one rather than a duplicate.
        const [existing] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.clientId, client.id),
              eq(documents.sha256, sha256),
              eq(documents.status, "ready"),
              isNull(documents.deletedAt),
            ),
          )
          .limit(1);
        if (existing) {
          // Its own action. A deduplicated upload created nothing, and a trail
          // that called this `document.upload` would show one document being
          // created as many times as it was re-submitted.
          await recordAuditEvent(tx, {
            actorUserId: actor.userId,
            action: AUDIT_ACTIONS.DOCUMENT_UPLOAD_DEDUPLICATED,
            resourceType: "document",
            resourceId: existing.id,
            outcome: "allowed",
            detail: { clientId: client.id },
          });
          return { kind: "existing", documentId: existing.id };
        }

        const documentId = uuidv7();
        const storageKey = documentStorageKey({
          firmId: client.firmId,
          clientId: client.id,
          documentId,
        });

        await tx.insert(documents).values({
          id: documentId,
          // OWNERSHIP INVARIANT. `firmId` comes from the authorized client row,
          // not from `actor.firmId`. Today the two are provably equal -- the query
          // above constrains `clients.firm_id = actor.firmId` -- so a mutation
          // swapping them survives the test suite. It is still the safer source:
          // if that tenant predicate were ever weakened, deriving from the
          // resource keeps the document in the client's real firm, whereas
          // deriving from the actor would file it under the caller's.
          firmId: client.firmId,
          clientId: client.id,
          storageKey,
          originalFilename: validation.filename,
          contentType: validation.contentType,
          byteSize: input.bytes.length,
          sha256,
          uploadedBy: actor.userId,
          status: "pending",
        });

        // Same transaction as the INSERT above: this is the atomicity the
        // whole arrangement exists for.
        await recordAuditEvent(tx, {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
          resourceType: "document",
          resourceId: documentId,
          outcome: "allowed",
          detail: { clientId: client.id },
        });

        return { kind: "reserved", documentId, storageKey };
      },
    );
  } catch (error) {
    // Only an audit failure becomes an outcome. A database failure during the
    // document INSERT propagates exactly as it did before, and an
    // `AuditDetailError` is a programmer error that must keep going.
    if (!(error instanceof AuditWriteError)) throw error;
    return AUDIT_FAILED;
  }

  if (reserved.kind === "denied") return DENIED;
  if (reserved.kind === "existing") {
    return { ok: true, documentId: reserved.documentId, deduplicated: true };
  }

  const { documentId, storageKey } = reserved;

  // --- 2. put -------------------------------------------------------------
  try {
    await deps.store.put(storageKey, input.bytes, validation.contentType);
  } catch {
    // No object was written. The row records the attempt and stays invisible.
    await markFailed(deps.db, documentId);
    return { ok: false, error: "STORAGE_FAILED" };
  }

  // --- 3. finalize --------------------------------------------------------
  let becameReady = false;
  let finalizationErrored = false;
  try {
    const updated = await deps.db
      .update(documents)
      .set({ status: "ready" })
      .where(
        and(
          eq(documents.id, documentId),
          // Only a pending row may become ready: a second finalisation of the
          // same document cannot occur.
          eq(documents.status, "pending"),
          eq(documents.firmId, actor.firmId),
          hasLiveWriteAccess(deps.db, actor, input.clientId),
        ),
      )
      .returning({ id: documents.id });
    becameReady = updated.length === 1;
  } catch {
    finalizationErrored = true;
  }

  if (becameReady) return { ok: true, documentId, deduplicated: false };

  // Compensation: the object exists but the document will never be visible, so
  // remove it. Best-effort by design — if the delete also fails, the row stays
  // `failed` WITH its storage key, which is a recoverable record rather than an
  // untraceable orphan. No background sweeper is built until a real failure
  // shows one is needed.
  let orphanObjectRemoved = true;
  try {
    await deps.store.delete(storageKey);
  } catch {
    orphanObjectRemoved = false;
  }
  await markFailed(deps.db, documentId);

  if (finalizationErrored) {
    // Infrastructure, not authorization. Recording this as a denial would put a
    // false statement in the trail about what the caller was allowed to do.
    return { ok: false, error: "FINALIZATION_FAILED", orphanObjectRemoved };
  }

  // A zero-row update means authorization changed under us. This IS a denial,
  // and it needs its own event: the reserve step already recorded an `allowed`
  // one, so leaving this unwritten would leave a trail claiming the operation
  // was permitted when the gate that mattered refused it.
  return auditUploadDenial(deps.db, actor, {
    clientId: input.clientId,
    documentId,
    reason: AUDIT_DENIAL_REASONS.REVOKED_BEFORE_FINALIZE,
  });
}

/**
 * Records an upload denial outside any transaction and returns the outcome.
 *
 * Used on the two denial paths that have nothing to roll back. Returns
 * `AUDIT_FAILED` rather than `DENIED` when the event cannot be written, because
 * "we refused you" and "we could not record what happened" are different
 * statements and only one of them is about the caller.
 */
async function auditUploadDenial(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  event: {
    reason: AuditDenialReason;
    clientId?: string;
    documentId?: string;
  },
): Promise<UploadOutcome> {
  const detail: Record<string, string> = { reason: event.reason };
  if (event.clientId) detail.clientId = event.clientId;

  try {
    await recordAuditEvent(db, {
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
      resourceType: "document",
      resourceId: event.documentId ?? null,
      outcome: "denied",
      detail,
    });
  } catch (error) {
    if (!(error instanceof AuditWriteError)) throw error;
    return AUDIT_FAILED;
  }

  return DENIED;
}

type ReserveResult =
  | { kind: "denied" }
  | { kind: "existing"; documentId: string }
  | { kind: "reserved"; documentId: string; storageKey: string };

/**
 * Moves a reserved row to `failed`.
 *
 * Guarded on `status = 'pending'`, so a `ready` document can never be dragged
 * backwards and a `failed` one is not rewritten -- both are terminal.
 *
 * Swallows its own error deliberately. It runs on paths that are already
 * failing, and throwing here would replace a structured outcome the caller can
 * act on with an exception that loses which stage failed. If this write does not
 * land, the database is unreachable and the row legitimately stays `pending` --
 * an interrupted operation, which is exactly what `pending` is for.
 */
async function markFailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  documentId: string,
): Promise<void> {
  try {
    await db
      .update(documents)
      .set({ status: "failed" })
      .where(and(eq(documents.id, documentId), eq(documents.status, "pending")));
  } catch {
    // Intentionally ignored -- see above.
  }
}
