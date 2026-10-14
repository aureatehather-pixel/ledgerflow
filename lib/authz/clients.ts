import { and, eq, isNull } from "drizzle-orm";

import type { AuthenticatedActor } from "@/lib/auth/session";
import { isUuid } from "@/lib/db/ids";
import { clientAssignments, clients, users } from "@/lib/db/schema";

/**
 * Client authorization.
 *
 * Two operations with genuinely different rules, which is why the role check
 * lives on one and the assignment check on the other rather than in a shared
 * abstraction. See the note at the bottom of this file.
 */

export type VisibleClient = { id: string; name: string; code: string };

/**
 * Clients the actor may see in a list.
 *
 * Role-differentiated, because the workflow differs: a partner or manager runs
 * the firm and needs to see its client list to administer engagements, whereas
 * staff should see only what they are working on. Note this governs the
 * *directory* only -- it grants nothing over the documents inside a client.
 * Reading a document always requires an assignment, for every role
 * (`findReadableDocument`).
 */
export async function listVisibleClients(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
): Promise<VisibleClient[]> {
  const selection = { id: clients.id, name: clients.name, code: clients.code };

  if (actor.firmRole === "partner" || actor.firmRole === "manager") {
    return db
      .select(selection)
      .from(clients)
      .where(
        // Tenant constraint in the WHERE clause, not a filter applied after.
        and(eq(clients.firmId, actor.firmId), isNull(clients.deletedAt)),
      );
  }

  return db
    .select(selection)
    .from(clients)
    .innerJoin(
      clientAssignments,
      and(
        eq(clientAssignments.clientId, clients.id),
        eq(clientAssignments.userId, actor.userId),
        isNull(clientAssignments.revokedAt),
      ),
    )
    .where(and(eq(clients.firmId, actor.firmId), isNull(clients.deletedAt)));
}

export type AssignmentRequest = {
  userId: string;
  clientId: string;
  accessLevel: "read" | "write";
};

/**
 * Grants a user access to a client.
 *
 * This is firm administration, so it is the one operation with a genuine role
 * requirement: only a partner or manager may widen who can see a client's
 * records. Without it, assignments would have to come from outside the system.
 *
 * Both the target user and the target client are resolved through queries
 * constrained to the actor's firm, so a partner in firm A cannot grant anyone
 * access to anything in firm B -- not by supplying a foreign user id, and not by
 * supplying a foreign client id.
 *
 * Returns `false` for every refusal. The caller cannot tell whether the role was
 * wrong, the user was foreign, or the client did not exist.
 */
export async function grantClientAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  request: AssignmentRequest,
): Promise<boolean> {
  if (actor.firmRole !== "partner" && actor.firmRole !== "manager") {
    return false;
  }

  // Malformed identifiers are refused, not passed to the driver. Without this a
  // caller-supplied string reaches a `uuid` comparison and raises, and a raised
  // refusal has a different shape from a returned one -- the same enumeration
  // oracle `findReadableDocument` and `uploadDocument` already guard against.
  // Found by the commit 6 audit tests; this path had no malformed-input case.
  if (!isUuid(request.userId) || !isUuid(request.clientId)) return false;

  // Target user must be a live member of the ACTOR'S firm. actor.firmId is the
  // only firm identifier trusted here; nothing the caller supplies names a firm.
  const targetUser = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, request.userId),
        eq(users.firmId, actor.firmId),
        isNull(users.deactivatedAt),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (targetUser.length === 0) return false;

  const targetClient = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, request.clientId),
        eq(clients.firmId, actor.firmId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);
  if (targetClient.length === 0) return false;

  await db.insert(clientAssignments).values({
    userId: request.userId,
    clientId: request.clientId,
    accessLevel: request.accessLevel,
    assignedBy: actor.userId,
  });
  return true;
}

/**
 * Revokes an assignment. Same role requirement and same firm constraint as
 * granting -- widening and narrowing access are the same administrative power.
 */
export async function revokeClientAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actor: AuthenticatedActor,
  request: { userId: string; clientId: string },
  at: Date = new Date(),
): Promise<boolean> {
  if (actor.firmRole !== "partner" && actor.firmRole !== "manager") {
    return false;
  }

  // Same guard as granting: widening and narrowing access take the same input
  // from the same caller, so they owe the same validation.
  if (!isUuid(request.userId) || !isUuid(request.clientId)) return false;

  const targetClient = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(eq(clients.id, request.clientId), eq(clients.firmId, actor.firmId)),
    )
    .limit(1);
  if (targetClient.length === 0) return false;

  await db
    .update(clientAssignments)
    .set({ revokedAt: at })
    .where(
      and(
        eq(clientAssignments.userId, request.userId),
        eq(clientAssignments.clientId, request.clientId),
        isNull(clientAssignments.revokedAt),
      ),
    );
  return true;
}

/*
 * On not extracting a shared helper yet.
 *
 * `grantClientAccess` and `revokeClientAccess` both open with the same
 * partner-or-manager test, and three functions across this file and
 * documents.ts resolve a client scoped to `actor.firmId`. That is two uses of
 * the role check and three of the tenant-scoped lookup.
 *
 * standards.md's rule of three says abstract at the third use, not the second.
 * The tenant-scoped client lookup has now reached three -- but the three differ
 * in what they select and what they join, so a shared helper would take
 * parameters for nearly everything it does.
 *
 * Revisited at commit 6, which is when the fourth use was expected to settle
 * the question. It did, in the opposite direction: `uploadDocument` resolves a
 * client through an assignment join constrained to `write`, inside a
 * transaction, and it needs `clients.firm_id` back. That is a fourth distinct
 * shape, not a confirmation of the first three. Still not abstracted --
 * deliberately, with the evidence, rather than by omission.
 *
 * What DID reach three and was extracted: the malformed-identifier guard, now
 * `isUuid` in `lib/db/ids.ts`.
 */
