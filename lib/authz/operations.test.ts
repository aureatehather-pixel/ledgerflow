import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allowedDetailKeys, type AuditAction } from "@/lib/audit";
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
import { failAuditInserts } from "@/lib/db/testing";

import { grantClientAccessForActor, readDocumentForActor } from "./operations";

const PASSWORD = "correct horse battery staple";

let h: AuthHarness;

beforeEach(async () => {
  h = await createAuthHarness();
});
afterEach(async () => {
  await h.close();
});

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

/** The same two-firm shape the denial matrix uses, plus a partner who may grant. */
async function seed() {
  const firmA = h.firm;
  const [firmB] = await h.db.insert(firms).values({ name: "Beta" }).returning();

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
  const partnerA = await h.createUser({
    email: "partner-a@x.test",
    password: PASSWORD,
  });
  const staffB = await provisionUser(h.db, {
    firmId: firmB!.id,
    email: "staff-b@x.test",
    name: "Staff B",
    password: PASSWORD,
  });

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
        status: "ready",
      })
      .returning();
    return doc!;
  };

  return {
    firmA,
    clientA1: clientA1!,
    clientA2: clientA2!,
    clientB1: clientB1!,
    staffA: { ...staffA, firmId: firmA.id },
    partnerA: { ...partnerA, firmId: firmA.id, firmRole: "partner" as const },
    staffB: { ...staffB, firmId: firmB!.id },
    docAssigned: await mkDoc(firmA.id, clientA1!.id, "assigned.pdf"),
    docSameFirmUnassigned: await mkDoc(firmA.id, clientA2!.id, "unassigned.pdf"),
    docOtherFirm: await mkDoc(firmB!.id, clientB1!.id, "foreign.pdf"),
  };
}

async function events() {
  return h.db.select().from(auditEvents);
}

// ---------------------------------------------------------------------------
// A7 — successful access is recorded
// ---------------------------------------------------------------------------

describe("audited document read: allowed", () => {
  it("returns the document and appends exactly one allowed event", async () => {
    const s = await seed();
    const result = await readDocumentForActor(
      h.db,
      actorFor(s.staffA),
      s.docAssigned.id,
    );

    expect(result).toMatchObject({ ok: true });
    expect((result as { document: { id: string } }).document.id).toBe(
      s.docAssigned.id,
    );

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("document.read");
    expect(rows[0]!.outcome).toBe("allowed");
    expect(rows[0]!.actorUserId).toBe(s.staffA.id);
    expect(rows[0]!.resourceType).toBe("document");
    expect(rows[0]!.resourceId).toBe(s.docAssigned.id);
    expect(rows[0]!.detail).toEqual({ clientId: s.clientA1.id });
    expect(rows[0]!.occurredAt).toBeInstanceOf(Date);
  });

  it("records one event per read, not one per session", async () => {
    const s = await seed();
    const actor = actorFor(s.staffA);
    await readDocumentForActor(h.db, actor, s.docAssigned.id);
    await readDocumentForActor(h.db, actor, s.docAssigned.id);
    expect(await events()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// A8 — denied access is recorded, for an AUTHENTICATED actor
// ---------------------------------------------------------------------------

describe("audited document read: denied", () => {
  it("appends exactly one denied event naming the actor and the resource", async () => {
    const s = await seed();
    const result = await readDocumentForActor(
      h.db,
      actorFor(s.staffA),
      s.docSameFirmUnassigned.id,
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("denied");
    expect(rows[0]!.actorUserId).toBe(s.staffA.id);
    // The resource the actor ASKED for, which is the whole point of the record.
    expect(rows[0]!.resourceId).toBe(s.docSameFirmUnassigned.id);
    expect(rows[0]!.detail).toEqual({ reason: "not_readable" });
  });

  it("records the cross-firm attempt too", async () => {
    const s = await seed();
    await readDocumentForActor(h.db, actorFor(s.staffA), s.docOtherFirm.id);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("denied");
    expect(rows[0]!.resourceId).toBe(s.docOtherFirm.id);
  });

  it("records a malformed identifier without letting it reach a uuid column", async () => {
    const s = await seed();
    const result = await readDocumentForActor(
      h.db,
      actorFor(s.staffA),
      "'; DROP TABLE documents;--",
    );

    expect(result).toEqual({ ok: false, error: "DENIED" });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("denied");
    expect(rows[0]!.resourceId).toBeNull();
  });

  it("keeps the response identical across every denial reason", async () => {
    const s = await seed();
    const actor = actorFor(s.staffA);
    const outcomes = [
      await readDocumentForActor(h.db, actor, s.docSameFirmUnassigned.id),
      await readDocumentForActor(h.db, actor, s.docOtherFirm.id),
      await readDocumentForActor(h.db, actor, "00000000-0000-7000-8000-00000000dead"),
      await readDocumentForActor(h.db, actor, "not-a-uuid"),
    ];
    // Auditing must not have introduced a distinguishable response.
    expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
    expect(await events()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Fail closed — and closed the same way on both paths
// ---------------------------------------------------------------------------

describe("audit failure withholds the document", () => {
  it("returns no document data when the event cannot be written", async () => {
    const s = await seed();
    await failAuditInserts(h.client);

    const result = await readDocumentForActor(
      h.db,
      actorFor(s.staffA),
      s.docAssigned.id,
    );

    // Authorization SUCCEEDED. The document is still withheld.
    expect(result).toEqual({ ok: false, error: "AUDIT_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain(s.docAssigned.storageKey);
    expect(JSON.stringify(result)).not.toContain("assigned.pdf");
    expect(await events()).toHaveLength(0);
  });

  it("does not report an audit failure as an authorization denial", async () => {
    const s = await seed();
    await failAuditInserts(h.client);

    const allowed = await readDocumentForActor(
      h.db,
      actorFor(s.staffA),
      s.docAssigned.id,
    );
    expect(allowed).not.toEqual({ ok: false, error: "DENIED" });
  });

  it("looks identical whether or not the actor could have read the document", async () => {
    const s = await seed();
    await failAuditInserts(h.client);
    const actor = actorFor(s.staffA);

    // If the two differed, AUDIT_UNAVAILABLE would itself confirm that a
    // document exists and the caller may see it.
    const wouldHaveBeenAllowed = await readDocumentForActor(
      h.db,
      actor,
      s.docAssigned.id,
    );
    const wouldHaveBeenDenied = await readDocumentForActor(
      h.db,
      actor,
      s.docOtherFirm.id,
    );
    expect(wouldHaveBeenAllowed).toEqual(wouldHaveBeenDenied);
  });
});

// ---------------------------------------------------------------------------
// Grants — atomicity of the write and its event
// ---------------------------------------------------------------------------

describe("audited client-access grant", () => {
  it("creates the assignment and exactly one allowed event", async () => {
    const s = await seed();
    const result = await grantClientAccessForActor(h.db, actorFor(s.partnerA), {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });

    expect(result).toEqual({ ok: true });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("client_access.grant");
    expect(rows[0]!.outcome).toBe("allowed");
    expect(rows[0]!.actorUserId).toBe(s.partnerA.id);
    expect(rows[0]!.resourceType).toBe("client");
    expect(rows[0]!.resourceId).toBe(s.clientA2.id);
    expect(rows[0]!.detail).toEqual({
      targetUserId: s.staffA.id,
      accessLevel: "write",
    });

    const assignments = await h.db
      .select()
      .from(clientAssignments)
      .where(eq(clientAssignments.clientId, s.clientA2.id));
    expect(assignments).toHaveLength(1);
  });

  it("records a refused grant and creates no assignment", async () => {
    const s = await seed();
    // staffA is not a partner or manager: the role check refuses.
    const result = await grantClientAccessForActor(h.db, actorFor(s.staffA), {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });

    expect(result).toEqual({ ok: false, error: "DENIED" });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("denied");
    expect(rows[0]!.detail).toMatchObject({ reason: "grant_refused" });

    const assignments = await h.db
      .select()
      .from(clientAssignments)
      .where(eq(clientAssignments.clientId, s.clientA2.id));
    expect(assignments).toHaveLength(0);
  });

  it("rolls the grant back when its audit row cannot be written", async () => {
    const s = await seed();
    const before = await h.db.select().from(clientAssignments);
    await failAuditInserts(h.client);

    const result = await grantClientAccessForActor(h.db, actorFor(s.partnerA), {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "write",
    });

    expect(result).toEqual({ ok: false, error: "AUDIT_UNAVAILABLE" });

    // The real evidence: the assignment INSERT committed inside the same
    // transaction is gone. A stubbed audit writer could not have shown this.
    const after = await h.db.select().from(clientAssignments);
    expect(after).toHaveLength(before.length);
    expect(
      after.some(
        (a: { clientId: string }) => a.clientId === s.clientA2.id,
      ),
    ).toBe(false);
    expect(await events()).toHaveLength(0);
  });

  it("keeps a caller-supplied identifier out of the log when it is malformed", async () => {
    const s = await seed();
    await grantClientAccessForActor(h.db, actorFor(s.partnerA), {
      userId: "x".repeat(500),
      clientId: s.clientA2.id,
      accessLevel: "write",
    });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).not.toHaveProperty("targetUserId");
    expect(JSON.stringify(rows[0]!.detail)).not.toContain("xxx");
  });
});

// ---------------------------------------------------------------------------
// Every emitted row, against the allowlist
// ---------------------------------------------------------------------------

describe("emitted detail conforms to the allowlist", () => {
  it("holds across every operation this module performs", async () => {
    const s = await seed();
    const staff = actorFor(s.staffA);
    const partner = actorFor(s.partnerA);

    await readDocumentForActor(h.db, staff, s.docAssigned.id);
    await readDocumentForActor(h.db, staff, s.docOtherFirm.id);
    await readDocumentForActor(h.db, staff, "not-a-uuid");
    await grantClientAccessForActor(h.db, partner, {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "read",
    });
    await grantClientAccessForActor(h.db, staff, {
      userId: s.staffA.id,
      clientId: s.clientA2.id,
      accessLevel: "read",
    });

    const rows = await events();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const allowed = allowedDetailKeys(row.action as AuditAction);
      for (const key of Object.keys(row.detail ?? {})) {
        expect(allowed).toContain(key);
      }
      // Belt and braces: no document identity beyond ids ever appears.
      const serialised = JSON.stringify(row.detail ?? {});
      expect(serialised).not.toContain(".pdf");
      expect(serialised).not.toContain("a".repeat(64));
    }
  });
});
