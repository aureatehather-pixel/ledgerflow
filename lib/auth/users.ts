import { eq } from "drizzle-orm";

import { accounts, sessions, users } from "@/lib/db/schema";

import { hashPassword } from "./password";

/**
 * Server-side user provisioning and lifecycle.
 *
 * Public sign-up is disabled in Better Auth; users reach the system only
 * through here. Tests use these same functions, so a fixture cannot drift from
 * production behaviour by baking in a pre-computed hash.
 */

/** Better Auth's provider id for email/password accounts. */
const CREDENTIAL_PROVIDER = "credential";

/**
 * Canonical email form, applied before both storage and lookup.
 *
 * NFKC first, then lowercase: normalising after casefolding can leave
 * visually-identical addresses in distinct forms, which would defeat the unique
 * index and allow two accounts for what a human reads as one address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

export interface ProvisionUserInput {
  firmId: string;
  email: string;
  name: string;
  password: string;
  firmRole?: "partner" | "manager" | "staff";
}

/**
 * Creates a user and their credential account.
 *
 * The Argon2id hash goes to `accounts.password` because that is where Better
 * Auth looks. There is no other credential store.
 */
export async function provisionUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: ProvisionUserInput,
): Promise<{ id: string; email: string }> {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx: typeof db) => {
    const [user] = await tx
      .insert(users)
      .values({
        firmId: input.firmId,
        email,
        name: input.name,
        firmRole: input.firmRole ?? "staff",
      })
      .returning({ id: users.id, email: users.email });

    await tx.insert(accounts).values({
      userId: user.id,
      accountId: user.id,
      providerId: CREDENTIAL_PROVIDER,
      password: passwordHash,
    });

    return user;
  });
}

/**
 * Deactivates a user and revokes every session they hold.
 *
 * Setting the flag alone would leave existing sessions valid until they expired.
 * The point of deactivation is that it takes effect now, so the sessions go with
 * it. The `databaseHooks` guard then stops new ones being minted.
 */
export async function deactivateUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx: typeof db) => {
    await tx
      .update(users)
      .set({ deactivatedAt: at })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}

/**
 * Soft-deletes a user: revokes sessions, marks the row, and TOMBSTONES the
 * email.
 *
 * The tombstone matters more than it looks. `users.email` is uniquely indexed
 * only WHERE `deleted_at IS NULL`, so a deleted address becomes reusable -- but
 * Better Auth knows nothing about `deleted_at` and would happily resolve a login
 * to the deleted row. Rewriting the address guarantees a later account with the
 * same email is the only one findable.
 *
 * Hard deletion is deliberately not implemented in M1.
 */
export async function softDeleteUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx: typeof db) => {
    const [existing] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing) return;

    await tx
      .update(users)
      .set({
        deletedAt: at,
        deactivatedAt: at,
        // Tombstone: unroutable by construction, and unique per user.
        email: `deleted+${userId}@invalid.local`,
      })
      .where(eq(users.id, userId));

    await tx.delete(sessions).where(eq(sessions.userId, userId));
    // The credential is destroyed with the account row: a soft-deleted user
    // must not retain a usable password hash.
    await tx.delete(accounts).where(eq(accounts.userId, userId));
  });
}
