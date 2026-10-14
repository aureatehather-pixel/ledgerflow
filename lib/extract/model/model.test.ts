import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TS_FILES, walkFiles } from "@/test/structural";

import type { CostCeiling } from "@/lib/cost/ceiling";
import { FAKE_RATE_TABLE, fixedClock } from "@/lib/cost/testing";
import { validateStatement } from "@/lib/domain/statement";

import type { ModelRequest } from "./adapter";
import { createFakeModelAdapter, wellFormedOutput } from "./fake";
import { meteredInvoke, type MeteredInvokeDeps } from "./invoke";
import { toStatementDraft, validateUsage } from "./schema";

const CEILING: CostCeiling = { perCallMicrocents: 10_000_000n, currency: "USD" };

const REQUEST: ModelRequest = {
  documentId: "00000000-0000-7000-8000-0000000000cc",
  instructions: "Extract the statement.",
  pages: [{ kind: "text", page: 1, text: "SYNTHETIC PAGE" }],
  maxOutputTokens: 2_000,
};

const TRANSFORM = { documentId: REQUEST.documentId, pageCount: 1 };

function deps(overrides: Partial<MeteredInvokeDeps> = {}): MeteredInvokeDeps {
  return {
    adapter: createFakeModelAdapter(),
    rateTable: FAKE_RATE_TABLE,
    ceiling: CEILING,
    now: fixedClock(),
    ...overrides,
  };
}

describe("a successful call", () => {
  it("returns a draft and a complete record", async () => {
    const adapter = createFakeModelAdapter({
      provider: "fake",
      requestId: "req_123",
    });
    const { record, draft } = await meteredInvoke(
      deps({ adapter }),
      REQUEST,
      TRANSFORM,
    );

    expect(record.outcome).toBe("succeeded");
    expect(record.provider).toBe("fake");
    expect(record.model).toBe("fake-model-1");
    expect(record.rateTableVersion).toBe("test-fixture-v1");
    expect(record.requestId).toBe("req_123");
    expect(record.documentId).toBe(REQUEST.documentId);
    expect(record.startedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(record.completedAt).toBe("2026-07-29T12:00:01.000Z");
    expect(record.failure).toBeUndefined();
    expect(draft).toBeDefined();
  });

  it("records every token class and both costs", async () => {
    const { record } = await meteredInvoke(deps(), REQUEST, TRANSFORM);

    expect(record.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    // Estimated prices the full 2,000-token cap; actual prices the 200 used.
    expect(record.estimatedMaximumCost).toBe(1_100_000n);
    expect(record.actualCost).toBe(200_000n);
    expect(record.actualCost! < record.estimatedMaximumCost!).toBe(true);
  });

  it("prices cache classes when the provider reports them", async () => {
    const adapter = createFakeModelAdapter({
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cacheCreationTokens: 8_000,
        cacheReadTokens: 1_000,
      },
    });
    const { record } = await meteredInvoke(deps({ adapter }), REQUEST, TRANSFORM);
    // 10,000 + 50,000 + 1,000,000 + 10,000
    expect(record.actualCost).toBe(1_070_000n);
  });

  it("produces a draft the domain still has to validate and reconcile", async () => {
    const { draft } = await meteredInvoke(deps(), REQUEST, TRANSFORM);
    expect(draft).toBeDefined();
    // A model cannot certify its own output: the draft goes through the same
    // structural gate as any other candidate.
    expect(validateStatement(draft!).ok).toBe(true);
  });
});

describe("the ceiling rejects before the provider is touched", () => {
  it("makes zero provider calls", async () => {
    const adapter = createFakeModelAdapter({ countTokens: 1_000_000 });
    const { record, draft } = await meteredInvoke(
      deps({ adapter, ceiling: { perCallMicrocents: 1n, currency: "USD" } }),
      REQUEST,
      TRANSFORM,
    );

    expect(record.outcome).toBe("rejected-before-invocation");
    expect(record.failure?.kind).toBe("COST_CEILING_EXCEEDED");
    expect(adapter.invocations()).toBe(0);
    expect(adapter.tokenCounts()).toBe(1);
    expect(draft).toBeUndefined();
  });

  it("records the estimate that caused the refusal", async () => {
    const adapter = createFakeModelAdapter({ countTokens: 1_000_000 });
    const { record } = await meteredInvoke(
      deps({ adapter, ceiling: { perCallMicrocents: 1n, currency: "USD" } }),
      REQUEST,
      TRANSFORM,
    );
    expect(record.estimatedMaximumCost).toBe(101_000_000n);
    expect(record.actualCost).toBeUndefined();
  });

  it("does not clamp, downgrade or shorten the request", async () => {
    // The request the adapter saw is the request as written -- nothing adapted
    // it to fit the budget.
    const adapter = createFakeModelAdapter({ countTokens: 1_000_000 });
    await meteredInvoke(
      deps({ adapter, ceiling: { perCallMicrocents: 1n, currency: "USD" } }),
      REQUEST,
      TRANSFORM,
    );
    expect(adapter.lastRequest()?.maxOutputTokens).toBe(2_000);
    expect(adapter.invocations()).toBe(0);
  });

  it("rejects when no rate exists, without calling the provider", async () => {
    const adapter = createFakeModelAdapter({ model: "unpriced-model" });
    const { record } = await meteredInvoke(deps({ adapter }), REQUEST, TRANSFORM);

    expect(record.outcome).toBe("rejected-before-invocation");
    expect(record.failure?.kind).toBe("PROCESSING_FAILED_PERMANENT");
    expect(adapter.invocations()).toBe(0);
  });

  it("rejects when token counting fails", async () => {
    const adapter = createFakeModelAdapter({ countTokens: "fail" });
    const { record } = await meteredInvoke(deps({ adapter }), REQUEST, TRANSFORM);
    expect(record.outcome).toBe("rejected-before-invocation");
    expect(adapter.invocations()).toBe(0);
  });
});

describe("outcomes are distinguishable", () => {
  it("separates a provider failure from malformed output", async () => {
    const failed = await meteredInvoke(
      deps({ adapter: createFakeModelAdapter({ invoke: "fail" }) }),
      REQUEST,
      TRANSFORM,
    );
    expect(failed.record.outcome).toBe("provider-invocation-failed");
    expect(failed.record.failure?.kind).toBe("PROVIDER_FAILED");
    expect(failed.record.usage).toBeUndefined();

    const malformed = await meteredInvoke(
      deps({ adapter: createFakeModelAdapter({ structuredOutput: { nope: 1 } }) }),
      REQUEST,
      TRANSFORM,
    );
    expect(malformed.record.outcome).toBe("provider-output-malformed");
  });

  it("records the cost of malformed output, because it was still billed", async () => {
    const { record } = await meteredInvoke(
      deps({ adapter: createFakeModelAdapter({ structuredOutput: "not json" }) }),
      REQUEST,
      TRANSFORM,
    );
    expect(record.outcome).toBe("provider-output-malformed");
    expect(record.actualCost).toBe(200_000n);
    expect(record.usage).toBeDefined();
  });

  it("returns no draft on any failure path", async () => {
    for (const script of [
      { invoke: "fail" as const },
      { structuredOutput: {} },
      { countTokens: "fail" as const },
    ]) {
      const { draft } = await meteredInvoke(
        deps({ adapter: createFakeModelAdapter(script) }),
        REQUEST,
        TRANSFORM,
      );
      expect(draft).toBeUndefined();
    }
  });
});

describe("provider usage is untrusted", () => {
  it.each([
    ["missing fields", { inputTokens: 1 }],
    ["non-integer", { inputTokens: 1.5, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ["negative", { inputTokens: -1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ["wrong type", { inputTokens: "1000", outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ["unexpected key", { inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, extra: 1 }],
    ["not an object", "usage"],
    ["null", null],
  ])("rejects %s usage", (_label, usage) => {
    const r = validateUsage(usage, REQUEST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("EXTRACTION_VALIDATION_FAILED");
  });

  it("rejects output tokens above the requested cap as contradictory", () => {
    const r = validateUsage(
      { inputTokens: 1, outputTokens: 9_999, cacheCreationTokens: 0, cacheReadTokens: 0 },
      REQUEST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("above the requested cap");
  });

  it("rejects an all-zero total on a successful call", () => {
    const r = validateUsage(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      REQUEST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("zero tokens");
  });

  it("surfaces malformed usage as an outcome, not a crash", async () => {
    const { record } = await meteredInvoke(
      deps({ adapter: createFakeModelAdapter({ usage: { inputTokens: -5 } }) }),
      REQUEST,
      TRANSFORM,
    );
    expect(record.outcome).toBe("provider-output-malformed");
    expect(record.actualCost).toBeUndefined();
  });
});

describe("structured output is untrusted", () => {
  it.each([
    ["a missing field", { ...wellFormedOutput(), accountReference: undefined }],
    ["an unexpected key", { ...wellFormedOutput(), glAccountCode: "5000" }],
    ["a numeric amount", { ...wellFormedOutput(), openingBalance: 1000 }],
    ["a bad currency", { ...wellFormedOutput(), currency: "RINGGIT" }],
    ["a non-object", 42],
    ["null", null],
  ])("rejects %s", (_label, output) => {
    const r = toStatementDraft(output, TRANSFORM);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("EXTRACTION_VALIDATION_FAILED");
  });

  it("rejects an ambiguous date rather than choosing a reading", async () => {
    const r = toStatementDraft(
      wellFormedOutput({
        lines: [
          { date: "03/04/2026", description: "X", debit: "", credit: "1.00", page: 1 },
        ],
      }),
      TRANSFORM,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("no convention was supplied");
  });

  it("rejects a malformed amount", () => {
    const r = toStatementDraft(
      wellFormedOutput({ openingBalance: "1,23.45" }),
      TRANSFORM,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain("openingBalance");
  });

  it("converts to domain values rather than passing the provider shape through", () => {
    const r = toStatementDraft(wellFormedOutput(), TRANSFORM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Strings in, sen and ISO dates out.
      expect(r.value.openingBalance).toBe(100_000n);
      expect(r.value.lines[0]?.credit).toBe(20_000n);
      expect(r.value.lines[0]?.date).toBe("2026-07-14");
      expect(r.value.lines[0]?.dateRaw).toBe("14/07/2026");
      expect(r.value.source.documentId).toBe(TRANSFORM.documentId);
    }
  });
});

describe("nothing echoes the payload", () => {
  it("keeps provider content out of validation failures", async () => {
    const secret = "ACCOUNT 8888888888 PAYEE CONFIDENTIAL SDN BHD";
    const { record } = await meteredInvoke(
      deps({
        adapter: createFakeModelAdapter({
          structuredOutput: { accountReference: secret, leaked: secret },
        }),
      }),
      REQUEST,
      TRANSFORM,
    );

    // A record holds Microcents, and JSON.stringify throws on a bigint -- the
    // serialisation boundary bigint money buys us. Persistence maps these to
    // numeric columns directly rather than through JSON; here a replacer is
    // enough to inspect the whole record.
    const serialised = JSON.stringify(record, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(record.outcome).toBe("provider-output-malformed");
    expect(serialised).not.toContain("8888888888");
    expect(serialised).not.toContain("CONFIDENTIAL");
  });

  it("strips the cause from every recorded failure", async () => {
    const { record } = await meteredInvoke(
      deps({ adapter: createFakeModelAdapter({ invoke: "fail" }) }),
      REQUEST,
      TRANSFORM,
    );
    expect(record.failure).toBeDefined();
    expect("cause" in record.failure!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The one-caller rule
// ---------------------------------------------------------------------------

describe("only lib/extract/model reaches a provider", () => {
  const SELF = fileURLToPath(import.meta.url);
  const ALLOWED = ["lib\\extract\\model\\", "lib/extract/model/"];
  /** SDKs that would constitute a second caller if one were ever added. */
  const PROVIDER_SDKS = ["@anthropic-ai/", "openai", "@google/generative-ai"];

  it("no provider SDK is installed at all", () => {
    // The strongest form of the rule in M2a: there is no SDK to call. A real
    // adapter arrives with credentials and its own live verification.
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const sdk of PROVIDER_SDKS) {
      expect(Object.keys(pkg.dependencies).some((d) => d.startsWith(sdk))).toBe(
        false,
      );
    }
  });

  it("no file outside lib/extract/model imports a provider SDK", () => {
    const offenders: string[] = [];
    for (const file of walkFiles(process.cwd(), TS_FILES)) {
      if (file === SELF) continue;
      if (ALLOWED.some((a) => file.includes(a))) continue;
      const code = readFileSync(file, "utf8");
      for (const sdk of PROVIDER_SDKS) {
        if (code.includes(`"${sdk}`) || code.includes(`'${sdk}`)) {
          offenders.push(`${file.replace(process.cwd(), "")}: ${sdk}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the dependency arrows pointing inward", () => {
    // The structural test above is a backstop. The real enforcement is that the
    // domain and the cost engine do not import the adapter at all, so there is
    // no path from them to a provider.
    for (const dir of ["lib/domain", "lib/reconcile", "lib/cost"]) {
      for (const file of walkFiles(join(process.cwd(), ...dir.split("/")), TS_FILES)) {
        expect(readFileSync(file, "utf8")).not.toContain("extract/model");
      }
    }
  });
});
