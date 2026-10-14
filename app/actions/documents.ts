"use server";

import { headers } from "next/headers";

import { getAuth } from "@/lib/auth/instance";
import { getAuthenticatedActor } from "@/lib/auth/session";
import { listVisibleClients } from "@/lib/authz/clients";
import {
  grantClientAccessForActor,
  readDocumentForActor,
} from "@/lib/authz/operations";
import { getDb } from "@/lib/db";

/**
 * Server Actions — the request boundary.
 *
 * Every action here follows the same three steps, and none of them may be
 * skipped or reordered:
 *
 *   1. resolve the actor through `getAuthenticatedActor`, the ONLY place session
 *      state is interpreted. Nothing in this file reads a cookie, a token, the
 *      sessions table, or an expiry;
 *   2. deny with a single undifferentiated failure when there is no actor;
 *   3. authorize the specific resource through a tenant-constrained query.
 *
 * `api.md` item 13 asks who may call each action, and "an authenticated user" is
 * not an answer -- each doc comment below names the actual rule.
 *
 * These return plain results rather than HTTP status codes; `api.md`'s
 * validation rules still apply ("a caller that returns a typed result instead of
 * a status code owes the same checks").
 *
 * **Audit lives one layer down**, in `lib/authz/operations.ts`, not here. This
 * file cannot be driven under test -- it reads `next/headers` -- and an audit
 * obligation verified only by reading the code is verified by inference. Each
 * action below is a thin adapter over an operation that can be proven against a
 * real database.
 *
 * **Unauthenticated callers are not audited.** They stop at step 2, before any
 * operation runs. That is deliberate: see
 * `docs/decisions/0002-audit-authenticated-denials-only.md`.
 */

/**
 * A denial carries no reason: distinguishing "not found" from "not yours" is
 * how an attacker maps another firm's document ids.
 *
 * `UNAVAILABLE` is separate because it is not a statement about the caller's
 * access at all -- the operation could not be recorded, so it did not happen.
 * It leaks nothing, because the audit write is attempted on the allowed and the
 * denied path alike: an audit outage looks the same whether or not the document
 * exists and whether or not the caller could have read it.
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "UNAVAILABLE" };

const DENIED = { ok: false, error: "NOT_FOUND" } as const;
const UNAVAILABLE = { ok: false, error: "UNAVAILABLE" } as const;

async function resolveActor() {
  return getAuthenticatedActor({
    auth: getAuth(),
    db: getDb(),
    headers: await headers(),
  });
}

/**
 * Who may call this: a user holding a live `client_assignments` row for the
 * document's client, where the document belongs to that user's firm. Firm
 * membership alone is not sufficient, and there is no partner override.
 */
export async function getDocumentMetadata(
  documentId: string,
): Promise<ActionResult<{ id: string; filename: string; byteSize: number }>> {
  const actor = await resolveActor();
  if (!actor) return DENIED;

  const result = await readDocumentForActor(getDb(), actor, documentId);
  if (!result.ok) {
    return result.error === "AUDIT_UNAVAILABLE" ? UNAVAILABLE : DENIED;
  }

  // Only the fields the caller needs. Storage keys and hashes stay server-side.
  return {
    ok: true,
    data: {
      id: result.document.id,
      filename: result.document.originalFilename,
      byteSize: result.document.byteSize,
    },
  };
}

/**
 * Who may call this: any authenticated, active user, for their own firm only.
 * Partners and managers see every client in the firm; staff see only clients
 * they are assigned to. The firm is taken from the authenticated actor and
 * cannot be supplied by the caller -- this action accepts no arguments at all.
 *
 * Not audited, deliberately. This returns the firm's own client directory --
 * names and codes, no client records -- and it is the call a listing screen
 * makes on every render, so auditing it would bury per-document accountability
 * under navigation noise. Revisit if the directory ever carries anything a
 * client would consider confidential.
 */
export async function listClients(): Promise<
  ActionResult<{ id: string; name: string; code: string }[]>
> {
  const actor = await resolveActor();
  if (!actor) return DENIED;
  return { ok: true, data: await listVisibleClients(getDb(), actor) };
}

/**
 * Who may call this: a partner or manager, granting access only to users and
 * clients within their own firm.
 */
export async function assignClientAccess(input: {
  userId: string;
  clientId: string;
  accessLevel: "read" | "write";
}): Promise<ActionResult<null>> {
  const actor = await resolveActor();
  if (!actor) return DENIED;

  const result = await grantClientAccessForActor(getDb(), actor, input);
  if (!result.ok) {
    return result.error === "AUDIT_UNAVAILABLE" ? UNAVAILABLE : DENIED;
  }
  return { ok: true, data: null };
}
