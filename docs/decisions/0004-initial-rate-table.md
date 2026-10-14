# 0004 — Initial production rate table

**Status** — accepted 2026-07-29 · **Table version** — `anthropic-global-standard-2026-07-29.1`

## Context

Commit 4 shipped the cost engine with an **empty** rate table, so every model failed to price. That was
correct while no dated rate decision existed, but it meant the ceiling could never bind on a real call.

`PROJECT-PLAN.md` §5 carried indicative prices catalogued **2026-06-24** with the instruction *"Re-verify
before relying on it"*. Those were **not** adopted: they were a month old, covered only two of the four
billable classes, and were recorded inside an entry titled *"OPEN, not decided"*.

## Decision

Adopt rates verified against **official Anthropic Claude Platform pricing documentation on 2026-07-29**.

### Supported billing mode

Every rate below applies to **exactly one** set of commercial terms, matched at lookup:

| Axis | Value |
|---|---|
| Platform | first-party Anthropic API |
| Inference | synchronous, standard |
| Routing | global |
| Cache writes | **five-minute TTL only** |
| Cache reads | included |

### Approved prices, per 1,000,000 tokens (USD)

| Model | Input | 5-min cache write | Cache read | Output |
|---|---|---|---|---|
| `claude-haiku-4-5` | $1.00 | $1.25 | $0.10 | $5.00 |
| `claude-sonnet-4-6` | $3.00 | $3.75 | $0.30 | $15.00 |

## The unit conversion, and why it is checked in code

The approved figures were supplied as **microcents per 1,000,000 tokens** (Haiku input `100_000_000`).
`ModelRate` stores **currency minor units per 1,000,000 tokens** (Haiku input `100`). Both express $1.00
per MTok — a cent is 1e6 microcents and a million tokens is 1e6 tokens, so the factors cancel — but as
integers they differ by a factor of a million.

**Writing the microcent figure into the minor-unit field would have overstated every bill 1,000,000×**,
turning $0.001 into $1,000. The mismatch was caught during review, so the conversion is now a checked
function, `minorUnitsPerMillion`, which throws on a non-exact conversion rather than truncating. The table
is written in the published microcent form and converted at construction, so this ADR and the source can be
compared line by line.

The storage unit is deliberately the one that needs **no division**: `cost_microcents = price × tokens`,
exact at every magnitude, with nothing to round.

## Explicitly out of scope

No rate exists for, and every one of these **fails loudly** at lookup: one-hour cache writes · Batch API ·
fast mode · US-only inference / `inference_geo` multipliers · AWS, Bedrock, Vertex AI, Microsoft Foundry or
any partner platform · negotiated discounts · server-side tool charges · **any model other than the two
named above**, including Opus and Fable tiers.

**A stated invariant:** `ModelRate` carries a single `cacheCreationPerMillion` and therefore *cannot*
distinguish a five-minute cache write from a one-hour one, which are priced differently. Rather than
approximate, `PricingMode.cacheWriteTtl` is pinned to `"5m"` and a one-hour request has no rate at all.
Supporting one-hour writes requires a second field and a new decision.

## What this decision does **not** do

**Pricing a model is not choosing it.** Which model performs extraction remains open (`PROJECT-PLAN.md`
§5) and is settled by measured accuracy and cost per document against a real statement corpus in M2b —
not by which models happen to be priced here. Nothing in the codebase selects a model.

## Reconsider when

- **Anthropic publishes new prices**, or an introductory rate lapses. Add a new table version; never edit
  this one, so historical calculations stay explicable.
- **A second billing mode is needed** — Batch (halves token cost, and `PROJECT-PLAN.md` §5 already names it
  as a lever), one-hour caching, or fast mode. Each needs its own priced entry and, for one-hour caching,
  a schema change.
- **A partner platform is adopted** (Bedrock, Vertex, Foundry). Partner pricing is separate and is not
  derivable from these figures.
- **A model outside the two above is selected** for extraction — the likeliest trigger, since the M2b
  measurement may point at a tier not priced here.
- **The verification goes stale.** These were checked on 2026-07-29. `CLAUDE.md` non-negotiable 7: an
  undated figure is a bug, and a figure dated long ago is one waiting to happen.
