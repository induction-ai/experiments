import { describe, expect, it } from "@experiments/test";
import { copyRates, wilson, type Series } from "./analysis.js";

const series: Series = {
  key: "test",
  label: "test",
  file: "",
  copiedColumn: "dots_queries",
  examplesColumn: "dots_in_history",
};

const row = (added: number, copied: number) => ({
  added: String(added),
  dots_in_history: String(added + 7),
  dots_queries: String(copied),
});

describe("copyRates", () => {
  it("counts the replies that copied at each number of examples", () => {
    const rates = copyRates(
      [row(4, 0), row(48, 1), row(48, 2), row(48, 0), row(4, 1)],
      series
    );
    expect(rates).toEqual([
      { examples: 11, n: 2, copied: 1 },
      { examples: 55, n: 3, copied: 2 },
    ]);
  });
});

describe("wilson", () => {
  it("brackets the observed share", () => {
    const [lo, hi] = wilson(13, 15);
    expect(lo).toBeLessThan(13 / 15);
    expect(hi).toBeGreaterThan(13 / 15);
  });

  it("stays within 0 and 1 at the extremes", () => {
    expect(wilson(0, 5)[0]).toBe(0);
    expect(wilson(5, 5)[1]).toBe(1);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
