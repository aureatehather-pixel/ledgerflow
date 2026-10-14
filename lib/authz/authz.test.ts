import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TS_SOURCE_FILES, stripComments, walkFiles } from "@/test/structural";

import type { AuthenticatedActor } from "@/lib/auth/session";
import { createAuthHarness, type AuthHarness } from "@/lib/auth/testing";
import { provisionUser } from "@/lib/auth/users";
import {
  auditEvents,
  clientAssignments,
  clients,
  documents,
  firms,
} from "@/lib/db/schema";

import { grantClientAccess, listVisibleClients, revokeClientAccess } from "./clients";
import { canWriteToClient, findReadableDocument } from "./documents";

const PASSWORD = "correct horse battery staple";

let h: AuthHarness;

beforeEach(async () => {
  h = await createAuthHarness();
});
afterEach(async () => {
  await h.close();
});

/** Builds an actor the way the canonical helper would, without going through a
 *  session -- authorization is what is under test here, not authentication. */
function actorFor(user: {
  id: string;
  firmId: string;
  email: string;
  firmRole?: "partner" | "manager" | "staff";
}): AuthenticatedActor {
  return {
    userId: user.id,
    firmId: user.firmId,
    email: user.email,
    firmRole: user.firmRole ?? "staff",
    sessionId: "00000000-0000-7000-8000-000000000000",
    sessionCreatedAt: new Date(),
  };
}

/** Two firms, each with a client and a document, and one assigned staff user in
 *  firm A. This is the shape every denial test needs. */
async function seedTwoFirms() {
  const firmA = h.firm;
  const [firmB] = await h.db
    .insert(firms)
    .values({ name: "Beta Accounting" })
    .returning();

  const [clientA1] = await h.db
    .insert(clients)
    .values({ firmId: firmA.id, name: "Acme", code: "ACME" })
    .returning();
  const [clientA2] = await h.db
    .insert(clients)
    .values({ firmId: firmA.id, name: "Zenith", code: "ZEN" })
    .returning();
  const [clientB1] = await h.db
    .insert(clients)
    .values({ firmId: firmB!.id, name: "Foreign", code: "FOR" })
    .returning();

  const staffA = await h.createUser({ email: "staff-a@x.test", password: PASSWORD });
  const staffB = await provisionUser(h.db, {
    firmId: firmB!.id,
    email: "staff-b@x.test",
    name: "Staff B",
    password: PASSWORD,
  });

  // staffA is assigned to clientA1 only -- NOT clientA2, same firm.
  await h.db.insert(clientAssignments).values({
    userId: staffA.id,
    clientId: clientA1!.id,
    accessLevel: "read",
  });

  const mkDoc = async (firmId: string, clientId: string, name: string) => {
    const [doc] = await h.db
      .insert(documents)
      .values({
        firmId,
        clientId,
        storageKey: `k/${name}`,
        originalFilename: name,
        contentType: "application/pdf",
        byteSize: 1024,
        sha256: "a".repeat(64),
        uploadedBy: staffA.id,
        // Explicit: only completed uploads are visible, so a fixture that wants
        // to be readable must say so rather than relying on a default.
        status: "ready",
      })
      .returning();
    return doc!;
  };

  return {
    firmA,
    firmB: firmB!,
    clientA1: clientA1!,
    clientA2: clientA2!,
    clientB1: clientB1!,
    staffA: { ...staffA, firmId: firmA.id },
    staffB: { ...staffB, firmId: firmB!.id },
    docAssigned: await mkDoc(firmA.id, clientA1!.id, "assigned.pdf"),
    docSameFirmUnassigned: await mkDoc(firmA.id, clientA2!.id, "unassigned.pdf"),
    docOtherFirm: await mkDoc(firmB!.id, clientB1!.id, "foreign.pdf"),
  };
}

// ---------------------------------------------------------------------------
// Document access
// ---------------------------------------------------------------------------

describe("document authorization", () => {
  it("allows an assigned user in the owning firm", async () => {
    const s = await seedTwoFirms();
    const doc = await findReadableDocument(
      h.db,
      actorFor(s.staffA),
      s.docAssigned.id,
    );
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(s.docAssigned.id);
  });

  it("denies a same-firm document the user is not assigned to", async () => {
    const s = await seedTwoFirms();
    // Same firm, valid document, real id -- and still denied, because firm
    // membership is not authorization.
    expect(
      await findReadableDocument(
        h.db,
        actorFor(s.staffA),
        s.docSameFirmUnassigned.id,
      ),
    ).toBeNull();
  });

  it("denies a document belonging to another firm", async () => {
    const s = await seedTwoFirms();
    expect(
      await findReadableDocument(h.db, actorFor(s.staffA), s.docOtherFirm.id),
    ).toBeNull();
  });

  it("denies once an assignment is revoked", async () => {
    const s = await seedTwoFirms();
    const actor = actorFor(s.staffA);
    expect(
      await findReadableDocument(h.db, actor, s.docAssigned.id),
    ).not.toBeNull();

    await h.db
      .update(clientAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(clientAssignments.userId, s.staffA.id));

    expect(await findReadableDocument(h.db, actor, s.docAssigned.id)).toBeNull();
  });

  it("denies a soft-deleted document", async () => {
    const s = await seedTwoFirms();
    await h.db
      .update(documents)
      .set({ deletedAt: new Date() })
      .where(eq(documents.id, s.docAssigned.id));
    expect(
      await findReadableDocument(h.db, actorFor(s.staffA), s.docAssigned.id),
    ).toBeNull();
  });

  it("denies a cross-firm document even when an assignment wrongly exists", async () => {
    const s = await seedTwoFirms();
    // Fabricate the assignment a bug elsewhere could create: staffA (firm A)
    // assigned to firm B's client. The assignment join would now PASS, so the
    // `documents.firm_id = actor.firmId` constraint is the only thing left
    // denying this. Without that constraint this test fails and the others do
    // not -- which is precisely why it exists.
    await h.db.insert(clientAssignments).values({
      userId: s.staffA.id,
      clientId: s.clientB1.id,
      accessLevel: "read",
    });
    expect(
      await findReadableDocument(h.db, actorFor(s.staffA), s.docOtherFirm.id),
    ).toBeNull();
  });

  it("ignores a caller-supplied firm id and uses the actor's", async () => {
    const s = await seedTwoFirms();
    // The attack: a firm A user claiming to be in firm B to reach firm B data.
    // The actor is the only source of firmId, so forging it just denies the
    // actor their own documents rather than granting anyone else's.
    const forged = { ...actorFor(s.staffA), firmId: s.firmB.id };
    expect(
      await findReadableDocument(h.db, forged, s.docOtherFirm.id),
    ).toBeNull();
    expect(await findReadableDocument(h.db, forged, s.docAssigned.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enumeration resistance
// ---------------------------------------------------------------------------

describe("enumeration resistance", () => {
  it("returns an identical result for foreign, unassigned and nonexistent ids", async () => {
    const s = await seedTwoFirms();
    const actor = actorFor(s.staffA);

    const results = [
      await findReadableDocument(h.db, actor, s.docOtherFirm.id),
      await findReadableDocument(h.db, actor, s.docSameFirmUnassigned.id),
      await findReadableDocument(h.db, actor, "00000000-0000-7000-8000-00000000dead"),
      await findReadableDocument(h.db, actor, "not-a-uuid"),
      await findReadableDocument(h.db, actor, ""),
    ];

    // Every denial is the same value. Nothing distinguishes "exists but not
    // yours" from "does not exist" -- which is what stops id enumeration.
    for (const result of results) expect(result).toBeNull();
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("does not throw on a malformed identifier", async () => {
    const s = await seedTwoFirms();
    // A thrown database error would be a distinguishable response, and therefore
    // an oracle.
    await expect(
      findReadableDocument(h.db, actorFor(s.staffA), "'; DROP TABLE documents;--"),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client listing — role-differentiated
// ---------------------------------------------------------------------------

describe("client listing", () => {
  it("shows staff only their assigned clients", async () => {
    const s = await seedTwoFirms();
    const visible = await listVisibleClients(h.db, actorFor(s.staffA));
    expect(visible.map((c) => c.code)).toEqual(["ACME"]);
  });

  it("shows partners every client in their firm", async () => {
    const s = await seedTwoFirms();
    const visible = await listVisibleClients(
      h.db,
      actorFor({ ...s.staffA, firmRole: "partner" }),
    );
    expect(visible.map((c) => c.code).sort()).toEqual(["ACME", "ZEN"]);
  });

  it("never shows another firm's clients, whatever the role", async () => {
    const s = await seedTwoFirms();
    for (const role of ["partner", "manager", "staff"] as const) {
      const visible = await listVisibleClients(
        h.db,
        actorFor({ ...s.staffA, firmRole: role }),
      );
      expect(visible.map((c) => c.code)).not.toContain("FOR");
    }
  });

  it("does not let a partner read documents of an unassigned client", async () => {
    const s = await seedTwoFirms();
    // Listing a client is directory visibility; reading its documents is not.
    // A partner sees ZEN in the list and still cannot open its documents.
    const partner = actorFor({ ...s.staffA, firmRole: "partner" });
    expect(
      await findReadableDocument(h.db, partner, s.docSameFirmUnassigned.id),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Assignment administration — role-gated
// ---------------------------------------------------------------------------

describe("assignment administration", () => {
  it("lets a partner grant access within their firm", async () => {
    const s = await seedTwoFirms();
    const granted = await grantClientAccess(
      h.db,
      actorFor({ ...s.staffA, firmRole: "partner" }),
      { userId: s.staffA.id, clientId: s.clientA2.id, accessLevel: "read" },
    );
    expect(granted).toBe(true);
    expect(
      await findReadableDocument(
        h.db,
        actorFor(s.staffA),
        s.docSameFirmUnassigned.id,
      ),
    ).not.toBeNull();
  });

  it("refuses a staff user", async () => {
    const s = await seedTwoFirms();
    const granted = await grantClientAccess(h.db, actorFor(s.staffA), {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });
    expect(granted).toBe(false);
    const rows = await h.db
      .select()
      .from(clientAssignments)
      .where(eq(clientAssignments.clientId, s.clientA2.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses to grant access to another firm's client", async () => {
    const s = await seedTwoFirms();
    const granted = await grantClientAccess(
      h.db,
      actorFor({ ...s.staffA, firmRole: "partner" }),
      { userId: s.staffA.id, clientId: s.clientB1.id, accessLevel: "read" },
    );
    expect(granted).toBe(false);
  });

  it("refuses to grant access to another firm's user", async () => {
    const s = await seedTwoFirms();
    const granted = await grantClientAccess(
      h.db,
      actorFor({ ...s.staffA, firmRole: "partner" }),
      { userId: s.staffB.id, clientId: s.clientA1.id, accessLevel: "read" },
    );
    expect(granted).toBe(false);
  });

  it("lets a manager revoke, and the revocation takes effect immediately", async () => {
    const s = await seedTwoFirms();
    const revoked = await revokeClientAccess(
      h.db,
      actorFor({ ...s.staffA, firmRole: "manager" }),
      { userId: s.staffA.id, clientId: s.clientA1.id },
    );
    expect(revoked).toBe(true);
    expect(
      await findReadableDocument(h.db, actorFor(s.staffA), s.docAssigned.id),
    ).toBeNull();
  });

  it("refuses revocation by a staff user", async () => {
    const s = await seedTwoFirms();
    expect(
      await revokeClientAccess(h.db, actorFor(s.staffA), {
        userId: s.staffA.id,
        clientId: s.clientA1.id,
      }),
    ).toBe(false);
    expect(
      await findReadableDocument(h.db, actorFor(s.staffA), s.docAssigned.id),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Write-level access (consumed by commit 5)
// ---------------------------------------------------------------------------

describe("write access", () => {
  it("refuses a read-only assignment", async () => {
    const s = await seedTwoFirms();
    expect(
      await canWriteToClient(h.db, actorFor(s.staffA), s.clientA1.id),
    ).toBe(false);
  });

  it("allows a write assignment", async () => {
    const s = await seedTwoFirms();
    await h.db
      .update(clientAssignments)
      .set({ accessLevel: "write" })
      .where(eq(clientAssignments.userId, s.staffA.id));
    expect(await canWriteToClient(h.db, actorFor(s.staffA), s.clientA1.id)).toBe(
      true,
    );
  });

  it("refuses a write assignment held against another firm's client", async () => {
    const s = await seedTwoFirms();
    // Fabricate an assignment that crosses firms, as a bug elsewhere might.
    await h.db.insert(clientAssignments).values({
      userId: s.staffA.id,
      clientId: s.clientB1.id,
      accessLevel: "write",
    });
    // The tenant join still denies it: the assignment exists, the client is not
    // in the actor's firm.
    expect(
      await canWriteToClient(h.db, actorFor(s.staffA), s.clientB1.id),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

describe("authorization primitives are side-effect free", () => {
  it("writes no audit events, on the allowed path or the denied one", async () => {
    const s = await seedTwoFirms();
    const actor = actorFor(s.staffA);
    // Denials.
    await findReadableDocument(h.db, actor, s.docOtherFirm.id);
    await findReadableDocument(h.db, actor, s.docSameFirmUnassigned.id);
    await grantClientAccess(h.db, actor, {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });
    // And a success, which is the half a purity check usually forgets.
    expect(await findReadableDocument(h.db, actor, s.docAssigned.id)).not.toBeNull();

    // NOT "audit is unimplemented" -- it is implemented, in
    // `lib/authz/operations.ts`, and `operations.test.ts` proves it appends on
    // both paths. This asserts the architecture that makes that possible: the
    // primitives decide, they do not record. Keeping them free of writes is
    // what lets the denial matrix above run exhaustively without a transaction,
    // and what stops a second, divergent audit path from appearing inside the
    // authorization queries themselves.
    expect(await h.db.select().from(auditEvents)).toHaveLength(0);
  });

  it("refuses a malformed identifier instead of raising", async () => {
    const s = await seedTwoFirms();
    // Regression: `grantClientAccess` used to pass this straight into a `uuid`
    // comparison, so a malformed id raised where a valid-but-forbidden one
    // returned false. A refusal that throws is a distinguishable response.
    await expect(
      grantClientAccess(h.db, actorFor({ ...s.staffA, firmRole: "partner" }), {
        userId: "'; DROP TABLE users;--",
        clientId: s.clientA2.id,
        accessLevel: "write",
      }),
    ).resolves.toBe(false);

    await expect(
      revokeClientAccess(h.db, actorFor({ ...s.staffA, firmRole: "partner" }), {
        userId: s.staffA.id,
        clientId: "not-a-uuid",
      }),
    ).resolves.toBe(false);

    expect(await h.db.select().from(auditEvents)).toHaveLength(0);
  });

  it("creates no assignment rows on a refused grant", async () => {
    const s = await seedTwoFirms();
    const before = await h.db.select().from(clientAssignments);
    await grantClientAccess(h.db, actorFor(s.staffA), {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });
    expect(await h.db.select().from(clientAssignments)).toHaveLength(
      before.length,
    );
  });
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("session authority is not duplicated", () => {
  /** Files permitted to interpret session state. */
  const AUTHORITY = ["lib\\auth\\", "lib/auth/"];

  it("no file outside lib/auth touches the sessions table or getSession", () => {
    const offenders: string[] = [];
    for (const file of walkFiles(process.cwd(), TS_SOURCE_FILES)) {
      if (AUTHORITY.some((a) => file.includes(a))) continue;
      // `schema.ts` defines the table; everything else must go through the
      // canonical helper rather than reading session rows itself.
      if (file.endsWith("schema.ts")) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bsessions\b/.test(code) || /getSession\s*\(/.test(code)) {
        offenders.push(file.replace(process.cwd(), ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every Server Action resolves its actor through getAuthenticatedActor", () => {
    const actionsDir = join(process.cwd(), "app", "actions");
    for (const file of walkFiles(actionsDir, TS_SOURCE_FILES)) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("getAuthenticatedActor");
      // No re-derivation of expiry or user state at the boundary.
      expect(source).not.toMatch(/expiresAt|deactivatedAt|SESSION_ABSOLUTE/);
    }
  });
});

// ---------------------------------------------------------------------------
// Query-level tenant constraints
// ---------------------------------------------------------------------------

describe("tenant constraints live in the queries", () => {
  it("keeps firm scoping in the WHERE clause of every authorization query", () => {
    for (const file of ["documents.ts", "clients.ts"]) {
      const source = readFileSync(join(process.cwd(), "lib", "authz", file), "utf8");
      // Not a proof of correctness -- the behavioural tests above are that.
      // This catches the specific regression of someone loading a resource
      // globally and comparing firm ids in memory afterwards.
      expect(source).toContain("actor.firmId");
      expect(source).not.toMatch(/===\s*actor\.firmId/);
      expect(source).not.toMatch(/!==\s*actor\.firmId/);
    }
  });
});
