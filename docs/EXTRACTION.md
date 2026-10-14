# The extraction engine — what it does, what it refuses, and what is missing

> **Scope.** The M2a engine: `lib/domain`, `lib/reconcile`, `lib/cost`, `lib/extract`, `lib/observability`,
> `lib/accuracy`. M1's authentication, authorization, upload and audit layers are described in
> `docs/SETUP.md`; this document does not repeat them.
>
> **Not a status document.** This describes the shape of what exists and, in §7, what deliberately does
> not. `README.md` carries the current summary.
>
> **Last reviewed** — 2026-07-30, at M2a commit 8.

---

## 1. The pipeline, in one line

```
bytes → input path → parser | model → validate → reconcile → persist
```

Six stages, each owned by exactly one directory, with a type boundary between them that a later stage
cannot talk its way around. The rest of this document is those boundaries and why each one is where it is.

The single entry point is `runExtraction` in `lib/extract/orchestration/pipeline.ts`. Nothing else composes
the stages; nothing else may.

**Routing is by document kind, and it is a fork rather than a fallback chain** (`pipeline.ts:376`):

| Document | Goes to | Because |
|---|---|---|
| `text-layer` | a parser from the registry | deterministic, free, and exact where the layout is known |
| `image-only` | the vision model | there is no local OCR, so pixels are the only input available |

A parser that *refuses* a text-layer document aborts the run; it does not escalate to the model. That is the
conservative reading of non-negotiable 6 — the model is for layouts no parser claims, and an unknown layout
is a routing outcome a human should see, not something to spend tokens on silently. Whether a
parser-refused document should escalate is an M2b decision, and it needs corpus evidence to make. See §7.

---

## 2. Three states of a statement, distinguished by type

This is the load-bearing idea in the whole engine.

| Type | Means | Produced only by |
|---|---|---|
| `StatementDraft` | *Proposed.* May be malformed, may not add up. | a parser, a model, or a test fixture |
| `Statement` | *Structurally valid* — every field present and well-formed. | `validateStatement` (`lib/domain/statement.ts`) |
| `ReconciledStatement` | Structurally valid **and** arithmetically balanced. | `requireReconciled` (`lib/reconcile/index.ts`) |

Because `ReconciledStatement` has exactly one constructor, and that constructor runs the gate, *"there is no
code path from a failed reconciliation to an export row"* (`CLAUDE.md` non-negotiable 3) is enforced by the
compiler rather than promised in a comment. M3b's export writers take a `ReconciledStatement` and will
therefore be structurally unable to accept anything else.

An extractor cannot assert that what it read is correct. It can only propose it. That asymmetry is the point.

---

## 3. Stage by stage

### 3.1 `lib/domain` — the primitives, and the refusals

- **Money is `Sen`**, a branded `bigint`. Never a float, never a `number`. `CLAUDE.md` § Money: a rounding
  error here is indistinguishable from fraud to an auditor.
- **Dates refuse ambiguity.** Malaysian statements print `DD/MM/YYYY`. A date that could be read two ways is
  a *typed failure*, not a guess — `03/04/2026` never silently becomes April 3rd. This is the worst failure
  mode the project has, because a wrong answer here is plausible-looking.
- **Failures are values, not exceptions.** `Result<T>` plus a closed `kind` taxonomy. `PublicFailure` is the
  narrowed shape that may cross a trust boundary: it carries no cause, no payload and no provider text.
- **The domain knows nothing about PDFs.** A test asserts no file in `lib/domain` mentions `pdfjs`, `canvas`,
  `getViewport` or `getTextContent`.

### 3.2 `lib/extract/input` — the only place PDF libraries exist

Two files, and a structural test that keeps it that way: **no file outside `lib/extract/input/` may import
`pdfjs-dist` or `@napi-rs/canvas`** (`lib/extract/registry.test.ts`). The test exempts itself, and only
itself, because it names both packages in its own case list.

- `pdf.ts` recovers per-page text and classifies the document as `text-layer` or `image-only`.
  `image-only` is a **routing signal, not a defect** — a scan reported as empty text would look like a
  statement with no transactions.
- `render.ts` rasterises pages for the vision path. **No OCR**: it produces pixels and does not attempt to
  read them. Nothing in M2a turns an image back into text.
- Nothing touches disk. Rendered bytes are returned to the caller and held nowhere else.

Why the boundary is worth a test: `pdfjs-dist` shipped 5.6 → 6.2 in four months and moved `destroy()`
between majors. Every bank parser M2b adds is written against `lib/extract/port.ts` instead, and survives
that. ADR `0003` records the dependency choice.

### 3.3 `lib/extract` — the parser port and the registry

`port.ts` is provider-neutral by construction: `ExtractedDocument`, `PageText`, `RenderedPage`,
`DocumentKind`. No PDF concept beyond "pages".

`registry.ts` selects a parser by **first match in registration order**, from an immutable registry passed in
explicitly. Not a module-level singleton parsers register into on import — that would make selection depend
on import order, and the failure would surface as a wrong number rather than an error. Duplicate parser ids
throw at construction: that is a wiring bug, and it would make run records ambiguous.

**No parser exists.** See §7.

### 3.4 `lib/extract/model` — the only directory that may reach a provider

Enforced by three tests in `model.test.ts`, not by convention:

- no provider SDK is installed at all;
- no file outside `lib/extract/model` imports one;
- the dependency arrows point inward.

`meteredInvoke` is the one function that calls `adapter.invoke`, in a fixed order:

```
count tokens → estimate worst case → enforce ceiling → invoke
  → validate usage → validate output → price actual usage
```

The order *is* the requirement. Nothing reaches a provider before the ceiling has passed.

**Provider output is untrusted twice over.** Reported token usage is validated (output above the requested
cap is contradictory; an all-zero total on a success is rejected), and the structured payload is converted
into domain values rather than passed through — so an ambiguous date from a model is refused by the same
code that refuses one from a parser.

**Nothing here logs, and no failure echoes the payload.** The request carries statement content and the
response carries transactions; recorded failures are stripped of their cause. Two tests assert this.

Four outcomes are kept distinct because they need different responses:
`rejected-before-invocation` (costs nothing, needs configuration) · `provider-invocation-failed` (may be
worth retrying) · `provider-output-malformed` (**was billed**, and is not worth retrying blindly) ·
`succeeded` (still has to pass reconciliation).

### 3.5 `lib/reconcile` — the gate

```
opening + Σ(credits) − Σ(debits) = closing
```

Off by any amount → exception for a human. **The module takes no tolerance parameter**, deliberately: an API
that accepts one is an API somebody eventually passes `1` to in order to make a fixture pass.

Pure and I/O-free, so it is exhaustively testable with no fixtures, no database and no network — which is
why it was built before any extractor existed. It is the correctness oracle everything downstream is
measured against.

A **running-balance check** is computed and reported as *advisory*, not as part of the gate. It catches a
class the endpoint equation cannot — two errors that cancel out — but promoting it needs corpus evidence
that banks print running balances consistently around fees and reversals. That is an M2b question, and the
advisory measurement is how it gets answered.

The negative control is mandatory and present: a statement with one transaction altered by **1 sen** is
rejected (`reconcile.test.ts`).

### 3.6 `lib/cost` — the **per-call** ceiling, checked before the call

`CLAUDE.md` non-negotiable 5: enforced in code, not watched in a dashboard, and it **fails loud**.

> **Scope limit, stated before the detail so it is not read past.** What exists is a **per-call** ceiling.
> Non-negotiable 5 requires a **monthly** one, and that does not exist — see §7 item 13. Everything in this
> section is true of the per-call check and says nothing about cumulative spend.

- **`Microcents`** — 1e-6 of a currency minor unit, its own branded type, never mixed with `Sen`. The unit is
  chosen so pricing needs *no division*: `cost = price_per_MTok × tokens`, integer throughout.
- **Estimates price the full `maxOutputTokens`.** Output length is unknowable in advance, so the estimate can
  only ever exceed the actual bill, never understate it.
- **The ceiling never adapts.** It does not clamp `max_tokens`, drop cache usage, shorten the request or
  reach for a cheaper model. A quietly downgraded extraction is worse than a refused one: it produces a
  confident answer from a request nobody approved. Choosing a cheaper model is the operator's decision,
  and no model has been chosen (§7 item 3).
- **Only approved prices ship, and everything outside them fails loudly.** The production table prices
  exactly the two models ADR `0004` approved, under the one billing mode it was verified for, and carries a
  version, an effective date and a source. An unpriced model, an unpriced provider, or a priced model under
  terms the table does not cover returns a permanent failure rather than a fallback rate — billing a request
  under terms it never ran under is the silent-wrong-number class this project treats as a defect. **Pricing
  a model is not choosing one:** nothing in the codebase selects a model, so the plan's *"no model is
  assumed"* remains a property of the code. Rates are data: revising them is an edit to one frozen object
  plus a version string, recorded in a dated decision.

### 3.7 `lib/extract/persistence` + migration `0005` — where a run lives

Tables: `extraction_runs`, `statements`, `statement_lines`, `provider_calls`.

**Tenant isolation is a foreign key, not a `WHERE` clause.** Composite keys carry `firm_id` through every
child row, so a cross-tenant write is rejected by the database and not merely by the query that forgot to
filter.

Three unique indexes do real work:

| Index | Prevents |
|---|---|
| `extraction_runs_document_attempt_unique` (firm, document, attempt) | two rows for the same attempt |
| `extraction_runs_one_success_per_document` (partial, `status = 'succeeded'`) | a second successful run for a document |
| `provider_calls_request_id_unique` | double-recording one provider call |

### 3.8 `lib/extract/orchestration` — the state machine

`machine.ts` holds **one total transition table**. Every (state, event) pair has an entry; `null` means
"not legal here" and is a decision, not an omission. A test walks the full cartesian product, so adding a
state or an event fails compilation *and* the suite until every combination has been considered.

States: `pending · running · succeeded · exception · failed`.
Events: `claim · succeed · raise_exception · fail · release`.

- **There is no edge out of `failed`.** A retry inserts a *new* run at the next attempt number, so the
  history of what was tried survives.
- **`release` is cancellation** — back to `pending`, never stuck. An abandoned run is released, not failed:
  recording a failure would misreport work that was never carried to a conclusion.
- **Idempotency is orchestration's job; the database is the net.** A completed run short-circuits before any
  work; each attempt claims its run with a conditional `UPDATE`, so a second caller loses the race; the
  partial unique index sits underneath both.
- **Queue-compatible without a queue.** No timer, no polling loop, no background process. The caller drives.
  A future worker replaces *the caller*, not this module — `claimRun` and `pending` are already the shape it
  needs.

### 3.9 `lib/observability` — operational events, and not the audit log

Event names and payload shapes are treated as a **public contract**, evolved additively only: new names and
new *optional* fields are safe; renaming, removing, retyping or narrowing is a breaking change. `events.test.ts`
pins the full name set and every payload's required fields, so a rename fails the suite rather than silently
breaking a consumer this repository cannot see.

**What may never appear in an event:** no secret, no document content, no description text, no account
reference, **no amount from a client's statement**.

That last one costs something, so it is handled rather than wished away: knowing a statement was out by one
sen rather than fifty thousand ringgit matters operationally, so `extraction.reconciliation.failed` carries a
**magnitude class** — an enumerated bucket — instead of the delta. The signal survives; the client's figure
stays in the database.

**Our own spend is not client data** and is logged in full. A ceiling rejection is useless without the number
that caused it.

These events are *operational* and may be sampled or dropped. `lib/audit` remains the immutable business
record of who accessed what, append-only at the database, and the only writer of `audit_events`. A test
asserts that emitting events writes none.

### 3.10 `lib/accuracy` — the mechanism, not the measurement

Produces the sentence `CLAUDE.md` § Verification demands: *"N of M transactions exact across K real
statements from J banks, dated."* It does **not** produce the number — that needs the real corpus M2b waits
on.

- **Ground truth is a `StatementDraft`.** Reusing the domain model rather than inventing a parallel shape is
  the firewall doing its job: a draft structurally cannot hold a GL account or a tax code, so ground truth
  cannot drift toward what an accounting system expects and away from what the document says.
- **Counts, never quotes.** A mismatch is reported as a line index and a field class. Nothing returns an
  expected-versus-actual amount or description: an accuracy report is read in the same places a log is, and
  the report of a failure must not become the leak.
- **`ratio` returns `null` on an empty denominator**, not 0 or 100. "100% of zero lines" is the kind of
  number that ends up in a status update.
- **Lines are compared by position.** Alignment — matching a line that shifted because an earlier one was
  missed — needs a corpus to know whether shifts happen and how. A missing line therefore cascades into the
  positions after it, and that cascade is *visible* in `missingLines` rather than hidden.
- `group` (bank or layout label) is deliberately unset and deliberately a free string. Naming a bank now
  would be inventing a layout taxonomy before seeing one.

---

## 4. Dependency direction

`A → B` reads "A imports B".

```
extract/orchestration → extract/{input, model, persistence, registry}
extract/model         → cost, domain, observability
reconcile             → domain
cost                  → domain
accuracy              → domain
domain                → nothing in this project
```

Arrows point inward, toward the domain, and nothing points back out. `model.test.ts` asserts mechanically
that **no file in `lib/domain`, `lib/reconcile` or `lib/cost` mentions `extract/model`** — so there is no
import path from the arithmetic to a provider, which is what makes those three exhaustively testable with no
fixtures and no network.

---

## 5. Where each non-negotiable is enforced

`CLAUDE.md`'s non-negotiables, mapped to the code that makes them true rather than to the comment that
restates them.

| # | Non-negotiable | Enforced by |
|---|---|---|
| 2 | The model never does arithmetic | a model reports only what the document *prints* — line items, and the stated opening and closing figures. Every sum is computed by `lib/reconcile` from the lines, and the printed closing balance is *checked against* the computed one rather than trusted |
| 3 | Reconciliation is a gate | `ReconciledStatement` has one constructor, and it is the gate. No tolerance parameter exists |
| 5 | Cost enforced in code, fails loud | **Partially.** The **per-call** half is enforced: `enforceCeiling` runs before `adapter.invoke`, and `meteredInvoke` is the only caller of it. The **monthly** half the non-negotiable also requires is **not implemented** — `CostCeiling` exposes only `perCallMicrocents` and no aggregation over `provider_calls` exists anywhere. See §7 item 13. *(This row read as unqualified enforcement until 2026-08-05. The gap was found by the external audit of 2026-07-31; this table — whose job is to say where each non-negotiable is actually enforced — was not updated at the time.)* |
| 6 | Deterministic first, model second | `pipeline.ts:376` sends a text-layer document to a parser and never to a model; the model path exists only for `image-only` input |
| 7 | Every price carries a date and a source | `PRODUCTION_RATE_TABLE` carries a version, an effective date and a source, and prices exactly the two models ADR `0004` approved under the one billing mode it was verified for. An unpriced model, provider or billing mode returns a permanent failure rather than a fallback rate — see §3.6. *(This row previously read "`PRODUCTION_RATE_TABLE` is empty", contradicting §3.6 of this same file. It is the third surface of post-convention drift defect 6 and was missed when the other two were corrected on 2026-07-30; found by external audit 2026-07-31.)* |
| 8 | Verification uses the firm's real documents | no parser is written, and no accuracy is claimed — §7 |

Non-negotiables 1 and 4 are unchanged by M2a: nothing here reads or writes a document from the filesystem,
and nothing exports.

---

## 6. How to verify it

```sh
npm run check      # typecheck + lint + the full suite, no network, no credentials
```

**The gates that must be proven to reject**, and where:

| What must be refused | Where it is proven |
|---|---|
| A statement out by 1 sen | `lib/reconcile/reconcile.test.ts` |
| An ambiguous `DD/MM` date, from a parser or a model | `lib/domain/dates.test.ts`, `lib/extract/model/model.test.ts` |
| A model call that would exceed the ceiling — **zero provider calls made** | `lib/cost/cost.test.ts`, `model.test.ts` |
| A model with no rate in the table | `lib/cost/cost.test.ts` |
| Provider-reported usage that contradicts the request | `lib/extract/model/model.test.ts` |
| An illegal run transition, for every (state, event) pair | `lib/extract/orchestration/machine.test.ts` |
| A second successful run for one document | `lib/extract/persistence/persistence.test.ts` |
| A cross-tenant statement write | `lib/extract/persistence/persistence.test.ts` |
| `pdfjs-dist` or `@napi-rs/canvas` imported outside `lib/extract/input` | `lib/extract/registry.test.ts` |
| A provider SDK imported outside `lib/extract/model` | `lib/extract/model/model.test.ts` |
| Payload content appearing in a failure or an event | `model.test.ts`, `observability.test.ts` |

**What none of this proves** — the concurrency claims. PGlite is a single in-process session, so the unique-index
backstop under `claimRun` is proved and the *claim race itself* is not. **That is still true of the suite**, and
it is why the race was proven elsewhere: against two real sessions on a disposable Neon branch, on
2026-07-31, recorded in an operator record outside this repository. That result covers the row-level
claim race, not end-to-end idempotency.

---

## 7. What does not exist

Stated as holes, in the same spirit as `docs/SETUP.md` §4.2. Anything below that gets believed instead of
checked is a defect in this document.

1. **No parser for any bank.** `StatementParser` is an interface with no implementation. Writing one against
   documents I generated would validate my assumptions, not a bank's layout (non-negotiable 8). M2b's first
   job.

   **Consequence, stated plainly:** with an empty registry, *every* text-layer document aborts at parser
   selection. The engine can currently extract nothing end-to-end except through the `image-only` model path,
   which itself has no real adapter (3). M2a built the machine, not a working extractor.

2. **No escalation from a refused parser to the model.** A text-layer document no parser claims fails; it does
   not fall through to the vision path. Deliberate for now — silently spending tokens on an unrecognised
   layout is the behaviour non-negotiable 6 exists to prevent — but it is a decision M2b should revisit with
   corpus evidence, not a permanent property.
3. **No model is chosen.** Two models are priced in ADR `0004` and **nothing in the codebase selects one** —
   pricing a model is not choosing it. *(This item previously ended "and the production rate table is
   empty", contradicting its own first clause; corrected 2026-07-30 with drift defect 6.)*
4. **No real provider adapter.** `ModelAdapter` has a fake implementation used by tests. No SDK is installed,
   and a test asserts that.
5. **No accuracy number.** The harness has never been run against a real document. Any accuracy claim about
   this system today is unfounded.
6. **No OCR.** A scanned page can be rendered to PNG for a vision model. Nothing converts an image back into
   text locally.
7. **No queue and no worker.** `pending` runs exist and are claimable; nothing claims them on a schedule.
8. **No classifier.** Every document is assumed to be a bank statement. Routing by type is M4.
9. **No export.** `ReconciledStatement` is the terminal type; nothing writes a UBS or SQL Account file. M3b,
   which is hard-gated on M0.
10. **No review surface.** Nothing shows a human a statement that failed the gate. M3a, which is gated on the
    design partner's workflow evidence. **The shape of that surface is an open question, not a pending
    implementation task.**
11. **No line-alignment logic.** Accuracy compares by position; a missed line shifts every position after it.
12. **The running-balance check is advisory**, not a gate.
13. **No monthly cost ceiling.** `CostCeiling` carries only `perCallMicrocents`, and **no aggregation over
    `provider_calls` exists anywhere** — nothing sums a firm's spend over a period, so nothing can refuse a
    call because the month's budget is gone. `CLAUDE.md` non-negotiable 5 requires exactly that, and calls it
    *"a defect of the same class as a swallowed error"*. The schema already supports the fix: `provider_calls`
    holds `firm_id`, `actual_cost_microcents` and `started_at`, with a `(firm_id, started_at)` index.

    **This is a half-met non-negotiable, not a missing feature request**, and it is the one item in this list
    that is *not* waiting on the design partner. It is also owned by **no milestone**: M2a's criterion B3 is
    written about the per-call refusal only, so B3 is met and the law is not. Found by external audit
    2026-07-31; added here 2026-08-05. **Assigning it to a milestone is an owner decision that has not
    been taken.**

*(Renumbered 2026-07-30: two items were both numbered 2. Recorded as a drift defect rather than fixed
silently, because a miscounted list of what does not exist is exactly the kind of claim this project has
agreed to count.)*

---

## 8. Pointers

| For | Read |
|---|---|
| Current summary and limitations | `README.md` |
| Project law and the non-negotiables | `CLAUDE.md` |
| Running it, security assumptions, the M1 gaps | `docs/SETUP.md` |
| Why pdf.js and `@napi-rs/canvas` | `docs/decisions/0003-pdf-input-dependencies.md` |
| The approved rate table and its date | `docs/decisions/0004-initial-rate-table.md` |
| The migration contract | `lib/db/migrations/README.md` |
