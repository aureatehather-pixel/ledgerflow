# LedgerFlow — Project Law

> **Working name.** "LedgerFlow" is a placeholder chosen so files could be written; renaming is cheap and expected.
> **Audience.** The working rules for anyone, human or coding agent, changing this repository. Where a
> personal or tool-level instruction file conflicts with this one, this one wins inside this repository.
> **Last reviewed** — 2026-10-14.

---

## What this is

> **Summary only.** `README.md` describes what exists today. This section exists so a reader of project
> law has enough context to apply it.

An AI-assisted document-intake pipeline for a Malaysian accounting firm: source documents in (bank statements,
supplier invoices, receipts), classified, extracted, reconciled, reviewed by an accountant, and exported as an
import file their existing system swallows without complaint. The firm posts into **Sage UBS and SQL Account**.
Built against one committed design-partner firm. Their real documents are the ground truth, and they never
enter this repository (non-negotiable 1).

The automation removes the typing, not the judgment.

---

## Load Table (this project)

Load only what the work in front of you touches.

| When | Read |
|---|---|
| Anything in `lib/extract`, `lib/reconcile`, `lib/cost`, `lib/domain` | `docs/EXTRACTION.md` |
| Configuration, auth, storage, or a security assumption | `docs/SETUP.md` |
| Schema or migrations | `lib/db/migrations/README.md` and `docs/decisions/0001-*` |
| Better Auth tables | `docs/AUTH-SCHEMA-RECONCILIATION.md` |
| `package.json` `overrides` | `docs/DEPENDENCY-OVERRIDES.md` |
| Anything naming an Anthropic model, price, or token limit | the `claude-api` skill — **never answer from memory** |

---

## Non-Negotiables (project)

These are absolute within this project. Breaking one needs an explicit go-ahead, asked for first.

1. **No real client data in the repository. Ever.** Not in tests, not in fixtures, not in an example in a
   docstring, not in a commit message, not in a screenshot. `samples/` is synthetic and obviously fake
   (`MAYBANK`→`SAMPLEBANK`, `88-Acme Sdn Bhd`). Real documents live in object storage, referenced by ID.
   A real statement reaching git history is a PDPA incident, not a tidy-up.

2. **The model never does arithmetic.** An LLM extracts *line items* — date, description, debit, credit.
   Every total, running balance, and reconciliation is computed in code from those line items. If a number in
   the output was produced by a language model rather than by addition, that is a defect.

3. **Reconciliation is a gate, not a report.** For any bank statement:
   `opening + Σ(credits) − Σ(debits) == closing`. Off by any amount → the statement is an **exception**,
   surfaced to a human. There is no threshold below which a mismatch is ignored, and no code path where a
   failed reconciliation still produces an export row.

4. **Nothing posts automatically.** The pipeline's terminal output is a file a named human approved. No
   direct writes into UBS or SQL Account, no scheduled unattended export.

5. **Cost is enforced in code, not watched in a dashboard.** Every model call records its token usage and
   computed cost against the document that caused it. A monthly ceiling is checked *before* the call and
   **fails loud** — the pipeline stops and says why. A silently-exceeded budget is a defect of the same class
   as a swallowed error.

6. **Deterministic first, model second.** For a document layout already known, parse it with code. The model
   is the fallback for unknown layouts, not the default path. This is cheaper *and* more accurate; the ordering
   is not negotiable for cost reasons alone.

7. **Every cost, price, or model-capability claim in this repo carries a date and a source.** These rot within
   months. An undated figure is a bug.

8. **Verification uses the firm's real documents, not my sample set.** The design partner is the ground truth.
   A parser validated only against documents I generated has been validated against my own assumptions.

---

## Conventions

**Stack** — Next.js (App Router) + TypeScript, Postgres, background queue for document processing, object
storage for documents. Region: Singapore or nearest, for latency and because where a Malaysian firm's
client documents are stored is a PDPA cross-border question, not only a latency one.

**Layout**

> **Documentation rule.** A current-architecture diagram describes implemented reality. Aspirational
> components appear only under a clearly labelled future-state heading. A directory that does not exist
> must never sit in the same list as one that does — the reader cannot tell which is which, and the
> unimplemented entry gets believed instead of checked.

*Implemented — M1 and M2a (this is what is on disk):*
```
app/                 routes + Server Actions
lib/
  auth/              the ONLY place session state is interpreted
  authz/             tenant, role and assignment authorization; the audited operation layer
  upload/            validation and upload orchestration (see below)
  audit/             the append-only trail; the ONLY writer of audit_events
  storage/           two-method object-storage port; R2 specifics never leave here
  db/                schema, ordered SQL migrations, migration runner
  domain/            Sen, unambiguous dates, the failure taxonomy, Statement
  reconcile/         the arithmetic gate. Pure functions, no I/O
  cost/              rate table, pre-call estimation, the ceiling
  extract/
    input/           the ONLY directory allowed to import pdfjs-dist or @napi-rs/canvas
    model/           the ONLY directory allowed to call a model provider
    orchestration/   run state machine, idempotent retries, cancellation
    persistence/     extraction runs, statements, lines, provider calls
  observability/     operational events. NOT the audit log
  accuracy/          the extraction-accuracy harness. Pure, and counts only
docs/decisions/      ADRs, NNNN-short-title.md
```

The engine's boundaries, its verification, and — read this before trusting it — **what it deliberately
cannot do yet** are in `docs/EXTRACTION.md`. No bank parser exists.

`lib/upload/` owns, and only owns: upload validation; the supported-MIME-type check; file-signature
validation (the declared type is a *claim*, the signature is *evidence*, and both must agree); size
validation; upload orchestration as reserve → put → finalize with authorization re-checked inside the
finalizing statement; and storage/database compensation when finalization fails.

**Malware scanning is not implemented in M1.** Signature checking establishes that a file *is* the type
it claims; it establishes nothing about whether the file is hostile. This is recorded as an open
security gap in `docs/SETUP.md` §4.2, not as a component of the current architecture. If it becomes a
requirement it lands as new work with its own decision record — it is not a thing this system quietly
already does.

*Planned. None of these exist yet — a test in `test/layout.test.ts` proves it:*
```
lib/
  classify/          document-type router (M4)
  extract/
    parsers/         per-layout parsers, one file per bank/format (M2b)
  export/            UBS + SQL Account writers (M3b — hard-gated on M0)
samples/             synthetic documents only
```

**Rules that follow from the layout.** Every rule below except the last is in force now, and each is held by
a **mechanical test rather than by discipline** — the test file is named so the claim can be checked instead
of believed.

- `lib/auth/` is the single authentication authority — `lib/auth/auth.test.ts`.
- `lib/audit/` is the single writer of `audit_events`, and the only place the per-action `detail`
  allowlist lives. A second writer is a hole in the audit trail — `lib/audit/audit.test.ts`.
- `lib/storage/` is a port. If an R2-specific type or error escapes that directory, the abstraction has
  already failed — `lib/storage/select.test.ts`.
- `lib/reconcile/` is pure and I/O-free, so it is tested exhaustively without fixtures or network, and it
  takes **no tolerance parameter** — `lib/reconcile/reconcile.test.ts`.
- Exactly one directory may call a model provider: `lib/extract/model/`. If a second appears, cost
  accounting has a hole in it — `lib/extract/model/model.test.ts`.
- Exactly one directory may import a PDF library: `lib/extract/input/`. Parsers are written against
  `lib/extract/port.ts` so a pdf.js major bump cannot reach them — `lib/extract/registry.test.ts`.
- `lib/observability/` emits operational events and writes **no** `audit_events`, and no event may carry a
  client's amount — `lib/observability/observability.test.ts`.
- One parser file per bank layout. Do not build an abstraction over two layouts; wait for the third. *(Binds
  at M2b, when the first parser exists.)*

**Money** — integer sen (minor units). Never a float, never a JS `number` for a balance. A rounding error
here is indistinguishable from fraud to an auditor.

**Dates** — Malaysian statements use `DD/MM/YYYY`. Store ISO-8601 UTC; render local. A date parsed with the
wrong day/month order is a silent, plausible-looking wrong answer — the worst failure mode this project has.

---

## Verification (project-specific)

Two general rules apply everywhere: verify against ground truth rather than against notes, and give every
check a negative control. Here that means:

- **The oracle is reconciliation.** Bank statements carry their own correctness check. Use it — it is the rare
  case where correctness is machine-checkable without a human labelling the answer.
- **The round-trip is the real test.** "The CSV generated" is `it compiled`. The test is a file importing
  cleanly into UBS and into SQL Account, confirmed by the firm.
- **Negative controls are mandatory for every gate.** Prove reconciliation *rejects*: feed it a statement with
  one transaction altered by 1 sen and assert it fails. Prove access control *denies*: assert a user from
  firm A gets nothing for firm B's document. A gate tested only on the passing case is indistinguishable from
  `return true`.
- **Accuracy is a number, not an impression.** "Extraction works well" is not a result. "N of M transactions
  exact across K real statements from J banks, dated" is.

---

## Out of scope (v1)

> A boundary a contributor must not cross belongs in project law.

Not building: a general ledger, tax computation, e-invoice/MyInvois submission, direct API integration with
UBS or SQL Account, multi-tenant SaaS onboarding, mobile apps, or anything that files anything with LHDN.

Explicitly deferred, not forgotten: multi-tenancy, and any automation that writes into
the firm's accounting system rather than handing them a file.
