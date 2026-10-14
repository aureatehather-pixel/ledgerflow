import { describe, expect, it } from "vitest";

import {
  compareIsoDates,
  isoDate,
  parseStatementDate,
  type ParseDateOptions,
} from "./dates";

function parsed(raw: string, options?: ParseDateOptions) {
  const r = parseStatementDate(raw, options);
  if (!r.ok) throw new Error(`expected "${raw}" to parse: ${r.failure.detail}`);
  return r.value;
}

function rejection(raw: string, options?: ParseDateOptions) {
  const r = parseStatementDate(raw, options);
  if (r.ok) throw new Error(`expected "${raw}" to be rejected`);
  return r.failure;
}

describe("unambiguous numeric dates", () => {
  it.each([
    ["14/07/2026", "2026-07-14"],
    ["14-07-2026", "2026-07-14"],
    ["14.07.2026", "2026-07-14"],
    ["31/12/2025", "2025-12-31"],
    ["25/03/2025", "2025-03-25"],
  ])("reads %s as %s because the day exceeds 12", (raw, expected) => {
    const p = parsed(raw);
    expect(p.value).toBe(expected);
    expect(p.interpretation).toBe("DMY");
  });

  it("treats an equal day and month as unambiguous", () => {
    // 05/05 is the same date under either reading, so there is nothing to
    // choose between and refusing would be pedantry rather than safety.
    const p = parsed("05/05/2025");
    expect(p.value).toBe("2025-05-05");
  });
});

describe("ambiguity is a failure, not a default", () => {
  it.each(["03/04/2026", "01/02/2025", "09/01/2025", "12/11/2024", "1/7/2026"])(
    "refuses %s when both readings are valid",
    (raw) => {
      const f = rejection(raw);
      expect(f.kind).toBe("AMBIGUOUS_DATE");
      expect(f.detail).toContain("no convention was supplied");
    },
  );

  it("refuses a single-digit token whose ambiguity is easy to miss", () => {
    // `1/7/2026` looks harmless and is exactly the shape that slips through:
    // 1 July under the documented convention, 7 January under the other.
    expect(parsed("1/7/2026", { assume: "DMY" }).value).toBe("2026-07-01");
    expect(parsed("1/7/2026", { assume: "MDY" }).value).toBe("2026-01-07");
  });

  it("resolves only when a convention is stated explicitly", () => {
    expect(parsed("09/01/2025", { assume: "DMY" }).value).toBe("2025-01-09");
    expect(parsed("09/01/2025", { assume: "MDY" }).value).toBe("2025-09-01");
  });

  it("records which convention produced the value", () => {
    expect(parsed("09/01/2025", { assume: "DMY" }).interpretation).toBe("DMY");
    expect(parsed("09/01/2025", { assume: "MDY" }).interpretation).toBe("MDY");
  });

  it("refuses a token that only MM/DD can explain", () => {
    // 03/25 is arithmetically unambiguous but contradicts the documented
    // Malaysian convention, so accepting it quietly would still be a guess.
    const f = rejection("03/25/2025");
    expect(f.kind).toBe("AMBIGUOUS_DATE");
    expect(f.detail).toContain("DD/MM/YYYY is expected");
    expect(parsed("03/25/2025", { assume: "MDY" }).value).toBe("2025-03-25");
  });
});

describe("month names carry no ambiguity", () => {
  it.each([
    ["14 JUL 2026", "2026-07-14"],
    ["9 January 2025", "2025-01-09"],
    ["01-Feb-2025", "2025-02-01"],
    ["3 sept 2024", "2024-09-03"],
    ["28 FEBRUARY 2025", "2025-02-28"],
  ])("reads %s as %s", (raw, expected) => {
    const p = parsed(raw);
    expect(p.value).toBe(expected);
    expect(p.interpretation).toBe("MONTH_NAME");
  });

  it("rejects an unrecognised month name", () => {
    expect(rejection("14 JULAI 2026").detail).toContain("unrecognised month");
  });
});

describe("calendar validity", () => {
  it("accepts 29 February in a leap year", () => {
    expect(parsed("29/02/2024").value).toBe("2024-02-29");
    expect(parsed("29/02/2000").value).toBe("2000-02-29"); // divisible by 400
  });

  it.each(["29/02/2025", "29/02/1900", "31/04/2025", "31/06/2025", "32/01/2025"])(
    "rejects %s",
    (raw) => {
      expect(rejection(raw).detail).toContain("not a real calendar date");
    },
  );

  it("rejects a zero day or month", () => {
    expect(rejection("00/01/2025").kind).toBe("AMBIGUOUS_DATE");
    expect(rejection("01/00/2025").kind).toBe("AMBIGUOUS_DATE");
  });

  it("rejects years outside the sanity range", () => {
    // A year of 0 or 9999 out of an extraction is a misread token, and it would
    // sort to the beginning or end of every list forever.
    expect(rejection("14/07/1899").kind).toBe("AMBIGUOUS_DATE");
    expect(rejection("14/07/2200").kind).toBe("AMBIGUOUS_DATE");
    expect(parsed("14/07/1900").value).toBe("1900-07-14");
    expect(parsed("14/07/2199").value).toBe("2199-07-14");
  });
});

describe("rejected formats", () => {
  it("rejects a two-digit year rather than guessing a century", () => {
    const f = rejection("14/07/26");
    expect(f.detail).toContain("two-digit year");
  });

  it.each(["", "   ", "not a date", "2026/07/14/01", "14//07/2026"])(
    "rejects %s",
    (raw) => {
      expect(rejection(raw).kind).toBe("AMBIGUOUS_DATE");
    },
  );
});

describe("ISO input", () => {
  it("accepts an already-canonical date", () => {
    const p = parsed("2026-07-14");
    expect(p.value).toBe("2026-07-14");
    expect(p.interpretation).toBe("ISO");
  });

  it("validates a canonical string read back from storage", () => {
    expect(isoDate("2026-07-14").ok).toBe(true);
    expect(isoDate("2026-02-30").ok).toBe(false);
    expect(isoDate("14/07/2026").ok).toBe(false);
  });
});

describe("provenance", () => {
  it("preserves the token exactly as printed", () => {
    // A reviewer comparing against the page needs what was printed, not what we
    // made of it.
    expect(parsed("  14 JUL 2026  ").raw).toBe("14 JUL 2026");
    expect(parsed("14.07.2026").raw).toBe("14.07.2026");
  });

  it("quotes the token in failures, unlike money", () => {
    // A date is provenance rather than financial content, so a report that will
    // not name the token cannot be acted on.
    expect(rejection("03/04/2026").detail).toContain("03/04/2026");
  });
});

describe("compareIsoDates", () => {
  it("orders chronologically", () => {
    const a = parsed("01/01/2025").value;
    const b = parsed("31/12/2025").value;
    expect(compareIsoDates(a, b)).toBe(-1);
    expect(compareIsoDates(b, a)).toBe(1);
    expect(compareIsoDates(a, a)).toBe(0);
  });

  it("sorts a list correctly as strings", () => {
    const dates = ["31/12/2025", "01/01/2025", "14/07/2025"].map(
      (d) => parsed(d).value,
    );
    expect([...dates].sort(compareIsoDates)).toEqual([
      "2025-01-01",
      "2025-07-14",
      "2025-12-31",
    ]);
  });
});
