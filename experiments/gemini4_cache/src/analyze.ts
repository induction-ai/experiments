// Aggregation shared by the report and the tests. Always over every row in a
// CSV, with the trial count beside every number.
import fs from "node:fs";
import { parseCsv } from "./csv.js";

export type Row = Record<string, string>;

export function readCsv(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  return parseCsv(fs.readFileSync(file, "utf8")).filter((r) => !r.error);
}

export function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

export interface MinimumCell {
  model: string;
  shape: string;
  words: number;
  n: number;
  hits: number;
  /** Hits on the first send of the final request (warm-ups only). */
  firstHits: number;
  prompt: number | null;
  cached: number | null;
}

/** One cell per (model, shape, words): how many trials hit at all. */
export function summariseMinimum(rows: Row[]): MinimumCell[] {
  const cells: MinimumCell[] = [];
  for (const [, rs] of groupBy(
    rows,
    (r) => `${r.model}|${r.shape}|${r.words}`
  )) {
    const hit = rs.filter((r) => (num(r.cached_max) ?? 0) > 0);
    cells.push({
      model: rs[0]!.model!,
      shape: rs[0]!.shape!,
      words: Number(rs[0]!.words),
      n: rs.length,
      hits: hit.length,
      firstHits: rs.filter((r) => (num(r.cached_first) ?? 0) > 0).length,
      prompt: median(rs.map((r) => num(r.prompt)).filter((x) => x !== null)),
      cached: median(hit.map((r) => num(r.cached_max)!)),
    });
  }
  return cells.sort(
    (a, b) =>
      a.model.localeCompare(b.model) ||
      a.shape.localeCompare(b.shape) ||
      a.words - b.words
  );
}

/** The gap `prompt − cached` on every send that hit. */
export function heldBack(
  rows: Row[]
): { model: string; gap: number; prompt: number }[] {
  return rows
    .filter((r) => (num(r.cached) ?? 0) > 0)
    .map((r) => ({
      model: r.model!,
      prompt: num(r.prompt)!,
      gap: num(r.prompt)! - num(r.cached)!,
    }));
}
