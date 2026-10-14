import { and, eq, isNull } from "drizzle-orm";

import type { AuthenticatedActor } from "@/lib/auth/session";
import { isUuid } from "@/lib/db/ids";
import {
  clientAssignments,
  clients as clientsTable,
  documents,
} from "@/lib/db/schema";

/**
 * Document authorization.
 *
 * Every function here resolves a document through a query whose WHERE clause
 * already carries the tenant boundary and the assignment join. Nothing is loaded
 * globally and compared in memory afterwards: a document the actor may not see
 * is never fetched at all, so there is no in-memory value for a later bug to
 * mishandle.
 *
 * `actor.firmId` is authenticated user context, not proof of access. Firm
 * membership alone authorizes nothing -- a live `client_assignments` row is
 * required for every read, including for partners.
 */

/** What the caller gets back. `null` for every denial, with no reason attached:
 *  "wrong firm", "not assigned" and "does not exist" must be indistinguishable
 *  or the caller can enumerate document ids. */
export type AuthorizedDocument = {
  id: string;
  firmId: string;
  clientId: string;
  storageKey: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
};

/**
 * Resolves a document the actor is authorized to read, or `null`.
 *
 * The four conditions are all in the WHERE clause:
 *   - the document is the one asked for;
 *   - it belongs to the actor's firm (tenant constraint);
 *   - it is not soft-deleted;
 *   - it reached `ready`, so its bytes are actually in storage;
 *   - the actor holds a live assignment to its client.
 */
export async function findReadableDocument(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  documentId: string,
): Promise<AuthorizedDocument | null> {
  if (!isUuid(documentId)) return null;

  const rows = await db
    .select({
      id: documents.id,
      firmId: documents.firmId,
      clientId: documents.clientId,
      storageKey: documents.storageKey,
      originalFilename: documents.originalFilename,
      contentType: documents.contentType,
      byteSize: documents.byteSize,
      sha256: documents.sha256,
    })
    .from(documents)
    .innerJoin(
      clientAssignments,
      and(
        eq(clientAssignments.clientId, documents.clientId),
        eq(clientAssignments.userId, actor.userId),
        isNull(clientAssignments.revokedAt),
      ),
    )
    .where(
      and(
        eq(documents.id, documentId),
        // Tenant constraint. Present even though the assignment join would
        // already exclude other firms -- two independent reasons to deny beat
        // one, and this is the cheapest possible defence against a future
        // refactor loosening the join.
        eq(documents.firmId, actor.firmId),
        isNull(documents.deletedAt),
        // Only completed uploads are visible. A `pending` row may have no bytes
        // behind it and a `failed` one certainly does not; either would be a
        // document that 404s on download while appearing in a listing.
        eq(documents.status, "ready"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether the actor may upload to a client. Used by commit 5's upload path;
 * defined here because it is the same authorization question as reading, one
 * access level higher.
 */
export async function canWriteToClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  clientId: string,
): Promise<boolean> {
  if (!isUuid(clientId)) return false;

  const rows = await db
    .select({ id: clientAssignments.id })
    .from(clientAssignments)
    .innerJoin(
      // Joining through `clients` is what applies the tenant constraint: an
      // assignment alone says nothing about which firm the client belongs to.
      clientsTable,
      and(
        eq(clientsTable.id, clientAssignments.clientId),
        eq(clientsTable.firmId, actor.firmId),
        isNull(clientsTable.deletedAt),
      ),
    )
    .where(
      and(
        eq(clientAssignments.clientId, clientId),
        eq(clientAssignments.userId, actor.userId),
        eq(clientAssignments.accessLevel, "write"),
        isNull(clientAssignments.revokedAt),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/*
 * The malformed-identifier guard used above is `isUuid` from `lib/db/ids.ts`.
 * It moved there when the audit writer became its third caller; the reasoning
 * it used to carry here -- not a security control, but a way to stop a
 * malformed id producing a differently-shaped response an attacker could
 * measure -- travelled with it.
 */

