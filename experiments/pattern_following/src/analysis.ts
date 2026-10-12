import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./csv.js";

export type Row = Record<string, string>;

const resultsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../results"
);

export function loadResults(file: string): Row[] {
  return parseCsv(fs.readFileSync(path.join(resultsDir, file), "utf8")).filter(
    (row) => row.error === ""
  );
}

/** One way of running the sweep, and which column says a reply copied. */
export type Series = {
  key: string;
  label: string;
  file: string;
  copiedColumn: string;
  examplesColumn: string;
};

export const SERIES: Series[] = [
  {
    key: "working",
    label: "`...` searches return real results",
    file: "dots/banking_021.csv",
    copiedColumn: "dots_queries",
    examplesColumn: "dots_in_history",
  },
  {
    key: "failing",
    label: "`...` searches return no results",
    file: "dots_failed/banking_021.csv",
    copiedColumn: "dots_queries",
    examplesColumn: "dots_in_history",
  },
  {
    key: "loop",
    label: "real searches in snake_case, repeated",
    file: "snake/banking_021.csv",
    copiedColumn: "snake_queries",
    examplesColumn: "snake_in_history",
  },
];

export const copied = (row: Row, column: string) => Number(row[column]) > 0;

export type RatePoint = { examples: number; n: number; copied: number };

/** Share of replies that copied, per number of examples in the history. */
export function copyRates(rows: Row[], series: Series): RatePoint[] {
  const byExamples = new Map<number, RatePoint>();
  for (const row of rows) {
    const examples = Number(row[series.examplesColumn]);
    const point = byExamples.get(examples) ?? { examples, n: 0, copied: 0 };
    point.n++;
    if (copied(row, series.copiedColumn)) point.copied++;
    byExamples.set(examples, point);
  }
  return [...byExamples.values()].sort((a, b) => a.examples - b.examples);
}

/** 95% Wilson score interval for `k` successes out of `n`. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Every file whose replies count toward the reasoning comparison. */
export const REASONING_SOURCES: {
  file: string;
  copiedColumn: string;
  setup: string;
}[] = [
  {
    file: "replay/banking.csv",
    copiedColumn: "stubbed_calls",
    setup: "real trajectories, all conditions",
  },
  {
    file: "dots/banking_021.csv",
    copiedColumn: "dots_queries",
    setup: "`...`, real results",
  },
  {
    file: "dots_failed/banking_021.csv",
    copiedColumn: "dots_queries",
    setup: "`...`, no results",
  },
  {
    file: "dots_instructed/banking_021.csv",
    copiedColumn: "dots_queries",
    setup: "`...`, told not to use `...`",
  },
  {
    file: "snake/banking_021.csv",
    copiedColumn: "snake_queries",
    setup: "snake_case, repeated",
  },
  {
    file: "snake_new/banking_021.csv",
    copiedColumn: "new_snake_queries",
    setup: "snake_case, never repeated",
  },
];

export type ReasoningPoint = {
  copied: boolean;
  reasoningTokens: number;
  setup: string;
};

export function reasoningPoints(): ReasoningPoint[] {
  return REASONING_SOURCES.flatMap(({ file, copiedColumn, setup }) =>
    loadResults(file).map((row) => ({
      copied: copied(row, copiedColumn),
      reasoningTokens: Number(row.reasoning_tokens),
      setup,
    }))
  );
}

export const REPLAY_CONDITIONS = [
  { key: "intact", label: "history as recorded" },
  { key: "keep_3", label: "stubbed, last 3 calls intact" },
  { key: "stub_last_3", label: "only the last 3 calls stubbed" },
  { key: "stub_all", label: "every past call stubbed" },
];

/**
 * Share of replay replies that wrote a `...` argument, per condition, over
 * the turns where the condition had stubbed something (every turn, for the
 * intact control).
 */
export function replayRates(): {
  key: string;
  label: string;
  n: number;
  copied: number;
}[] {
  const rows = loadResults("replay/banking.csv");
  return REPLAY_CONDITIONS.map(({ key, label }) => {
    const rs = rows.filter(
      (r) =>
        r.condition === key &&
        (key === "intact" || Number(r.stubbed_in_history) > 0)
    );
    return {
      key,
      label,
      n: rs.length,
      copied: rs.filter((r) => copied(r, "stubbed_calls")).length,
    };
  });
}
