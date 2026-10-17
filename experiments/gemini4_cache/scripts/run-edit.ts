/**
 * Question: is a cache hit all or nothing per stored entry, or does a
 * request that diverges partway still reuse everything before the edit?
 *
 * Per trial: see src/edit.ts. A warm single message is edited (one word
 * replaced) at each fraction in FRACS, each edit sent once. One CSV row per
 * send (`kind` = base or edit).
 *
 * Partial reuse: the edit at f caches about f × prompt. All or nothing: every
 * edit caches 0 (or only what some other, shorter entry covers).
 *
 * SHAPES crosses this with `one` (a single message) and `split` (the same
 * text as a user and a model message cut at 40%): see src/edit.ts.
 *
 * Appends RUNS trials per (model, shape) to results/edit.csv; FRESH=true
 * wipes it.
 *
 * Env: MODELS (both), SHAPES (one,split), WORDS (20000), FRACS ("0.1,0.5,0.9,0.98"), RUNS (1),
 * DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { EDIT_SHAPES, runEdit, type EditShape } from "../src/edit.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/edit.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "trial",
  "model",
  "words",
  "shape",
  "seed",
  "nonce",
  "kind",
  "send",
  "frac",
  "prompt",
  "cached",
  "error",
] as const;

const list = (v: string | undefined, d: readonly string[]) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...d];

const models = list(process.env.MODELS, MODELS);
const WORDS = Number(process.env.WORDS ?? 20000);
const FRACS = list(process.env.FRACS, ["0.1", "0.5", "0.9", "0.98"]).map(
  Number
);
const shapes = list(process.env.SHAPES, EDIT_SHAPES) as EditShape[];
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const shape of shapes) {
      tasks.push(async () => {
        const seed = crypto.randomInt(1, 2 ** 31);
        const nonce = crypto.randomBytes(6).toString("hex");
        const t = await runEdit({
          model,
          words: WORDS,
          fracs: FRACS,
          shape,
          seed,
          nonce,
          delayMs: DELAY_MS,
        });
        const base = {
          timestamp: new Date().toISOString(),
          batch,
          run,
          trial: nonce,
          model,
          words: WORDS,
          shape,
          seed,
          nonce,
        };
        const rows: Record<string, string | number | null | undefined>[] = [
          ...t.base.map((u, send) => ({
            ...base,
            kind: "base",
            send,
            prompt: u.prompt,
            cached: u.cached,
          })),
          ...t.edits.map((e, i) => ({
            ...base,
            kind: "edit",
            send: t.base.length + i,
            frac: e.frac,
            prompt: e.usage.prompt,
            cached: e.usage.cached,
          })),
        ];
        if (t.error)
          rows.push({
            ...base,
            kind: "error",
            send: rows.length,
            error: t.error,
          });
        appendRows(OUT, COLUMNS, rows);
        console.log(
          `${model} ${shape} base ${t.base.map((u) => `${u.cached}/${u.prompt}`).join(" ")} | ${t.edits.map((e) => `${e.frac}:${e.usage.cached}`).join(" ")}${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`
        );
      });
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
