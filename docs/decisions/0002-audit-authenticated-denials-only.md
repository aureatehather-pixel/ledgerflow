# 0002 — The audit trail records authenticated actors only, and fails closed

**Status** — Accepted · 2026-07-29

**Context** — M1 acceptance criteria A7 and A8 require that access-controlled operations append an
`audit_events` row on success *and* on denial. A8 carries its own qualification: denials are recorded
"where doing so neither exposes information nor creates an abuse vector." Four questions had to be settled
before any of it could be written, and each one has a wrong answer that looks reasonable.

**1. Which denials get recorded.** A denial can terminate at two very different places. An *unauthenticated*
request stops at `getAuthenticatedActor` before any operation runs: there is no actor, so `actor_user_id`
would be null on every row, and the rows would be indistinguishable from one another. An *authenticated*
denial is the opposite — a named person inside a named firm reaching for a client they are not assigned
to. That is the event an accounting firm actually needs answered, and it is the insider case client
confidentiality exists to constrain.

Recording unauthenticated attempts would also make an unauthenticated flood into a database write per
request — a write amplifier reachable by anyone on the internet, with no credential and no rate limit in
front of it. That is precisely the abuse vector A8 names.

**2. What an audit-write failure means.** If the event cannot be written, the operation is unrecorded. An
unrecorded read of a client's records is exactly what the trail exists to prevent, so returning the
document anyway would make the log a best-effort artefact rather than evidence.

**3. Whether an audit failure can be reported as a denial.** It cannot. "You may not have this" and "we
could not record what happened" are different statements, and collapsing them puts a false claim in the
trail about what a person was permitted to do.

**4. Whether the trail can be rewritten.** `schema.ts` had asserted since `0000` that "nothing may edit a
row." Nothing enforced it. The application connects as the table owner, so no `GRANT` would have helped.

---

**Decision**

1. **Only authenticated actors are audited.** `AuditEventInput.actorUserId` is required. Unauthenticated
   requests are refused at the boundary and write nothing. The `actor_user_id` column stays nullable for
   the reversal below, not because this code ever writes null.

2. **Fail closed.** No protected data is returned unless its audit row is durable. For writes, the
   operation and its event share one transaction, so an audit failure rolls the operation back. For reads,
   the caller receives `AUDIT_UNAVAILABLE` and no document.

3. **An audit failure is never a denial.** `AuditWriteError` is a distinct type; `readDocumentForActor`,
   `grantClientAccessForActor` and `uploadDocument` each surface it as its own outcome
   (`AUDIT_UNAVAILABLE` / `AUDIT_FAILED`), which the Server Action maps to `UNAVAILABLE` rather than
   `NOT_FOUND`. A programmer error (`AuditDetailError`) is never converted into an outcome at all — it
   propagates and crashes.

4. **`audit_events` is append-only in the database.** Migration `0004` installs a trigger that raises on
   every `UPDATE`. `DELETE` is deliberately left open because document retention (M5) will need to expire
   rows under a policy that does not exist yet — a deferral, not a permission. No application code may
   delete an audit event.

5. **The actor foreign key became `ON DELETE RESTRICT`.** Not a separate decision — a consequence of (4)
   that only appeared when the tests ran. `SET NULL` is implemented by Postgres as
   `UPDATE ONLY audit_events SET actor_user_id = NULL`, so with the trigger in place, deleting a user
   failed outright. The two properties the schema had claimed since `0000` — *"history survives the actor"*
   and *"nothing may edit a row"* — were never compatible.

   Resolved in favour of append-only, on the grounds that nulling the actor does not preserve history; it
   erases the one field that makes an event evidence. RESTRICT is already what `documents.uploaded_by`
   does, so hard user deletion was blocked for uploaders regardless — this makes the two consistent rather
   than adding a rule. It costs the real workflow nothing: the application soft-deletes
   (`deletedAt`, `deactivatedAt`) and no code path hard-deletes a user.

   *Reversal path:* the `.down.sql` restores `SET NULL`, but only after dropping the trigger — in the other
   order, user deletion breaks again. If a user must genuinely be erased, that is now a deliberate
   operation, the same class as the M5 retention question left open above.

5. **`detail` is a per-action allowlist.** Filenames, bytes, document contents, hashes, secrets, exception
   text and arbitrary caller metadata cannot be written, because no parameter carries them. Identifiers are
   admitted only after a UUID shape check. Denial *reasons* are stored, from a closed enum: non-disclosure
   constrains what crosses the boundary to a caller, not what the firm's own trail may hold.

---

**Why `AUDIT_UNAVAILABLE` does not leak**

A distinct error for infrastructure failure is normally an information leak: if it could only occur after
authorization succeeded, its appearance would confirm that the document exists and the caller may read it.

It does not occur only there. The audit write is attempted on the allowed path *and* the denied path, so an
audit outage produces the same result either way. `operations.test.ts` asserts this directly — "looks
identical whether or not the actor could have read the document" — and `upload.test.ts` asserts the upload
equivalent. **If a future change ever audits only successes, that test fails, and it should.**

---

**Consequences**

- An unauthenticated attack leaves nothing in `audit_events`. Accepted: it also leaves no identity worth
  recording, and the alternative is a write amplifier.
- A database problem confined to `audit_events` takes reads down rather than serving them unrecorded. This
  is the intended trade and the reason the table has no dependency on anything but itself.
- Validation rejections and the client *directory* listing are not audited. Neither is an access decision
  over client records; both are high-frequency and would bury per-document accountability in noise.

**Reconsider when any of these becomes true**

- **A rate-limited security-event mechanism exists at the edge**, separate from `audit_events` — at which
  point unauthenticated failures have somewhere to go that cannot be used to amplify writes. **This should
  be settled before the first non-localhost deployment**, since that is when unauthenticated traffic
  becomes real.
- **Retention lands (M5)** and needs a controlled path to expire audit rows. That work owns the `DELETE`
  question `0004` deliberately left open.
- **A third stale-status defect appears** in the sense of PROJECT-PLAN §6 — unrelated to this ADR, but it
  is the trigger for mechanising the status-vs-why convention this file follows.

**Status of the implementation is not recorded here.** It lives in the PROJECT-PLAN progress log and the
M1 commit-sequence table, per the documentation-drift mitigation in PROJECT-PLAN §6.
