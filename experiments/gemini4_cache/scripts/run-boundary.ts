/**
 * Question: when the last message of a request is edited, can the request
 * still reuse the cache entry of an earlier request that ended at a previous
 * message boundary?
 *
 * Per trial: see src/boundary.ts (variants cold, after_u1, edit_u1).
 *
 * "Whole earlier requests only": cold → 0, after_u1 → about the [u1]
 * request's prompt minus the held-back tail, edit_u1 → 0. "Any intact span":
 * cold also reuses A's span up to the edit.
 *
 * Appends RUNS trials per (model, variant) to results/boundary.csv;
 * FRESH=true wipes it first.
 *
 * Env: MODELS (both), VARIANTS (all), PRE_WORDS (14000), POST_WORDS (8000),
 * RUNS (1), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDARY_VARIANTS,
  runBoundary,
  type BoundaryVariant,
} from "../src/boundary.js";
import { appendRows } from "../src/csv.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/boundary.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "variant",
  "pre_words",
  "post_words",
  "seed",
  "nonce",
  "prompt_u1",
  "cached_u1",
  "prompt_a",
  "cached_a1",
  "cached_a2",
  "prompt_edited",
  "cached_edited",
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
const variants = list(
  process.env.VARIANTS,
  BOUNDARY_VARIANTS
) as BoundaryVariant[];
const PRE_WORDS = Number(process.env.PRE_WORDS ?? 14000);
const POST_WORDS = Number(process.env.POST_WORDS ?? 8000);
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const variant of variants) {
      tasks.push(async () => {
        const seed = crypto.randomInt(1, 2 ** 31);
        const nonce = crypto.randomBytes(6).toString("hex");
        const t = await runBoundary({
          model,
          variant,
          preWords: PRE_WORDS,
          postWords: POST_WORDS,
          seed,
          nonce,
          delayMs: DELAY_MS,
        });
        const row = {
          timestamp: new Date().toISOString(),
          batch,
          run,
          model,
          variant,
          pre_words: PRE_WORDS,
          post_words: POST_WORDS,
          seed,
          nonce,
          prompt_u1: t.u1?.prompt,
          cached_u1: t.u1?.cached,
          prompt_a: t.a[0]?.prompt,
          cached_a1: t.a[0]?.cached,
          cached_a2: t.a[1]?.cached,
          prompt_edited: t.edited?.prompt,
          cached_edited: t.edited?.cached,
          error: t.error,
        };
        appendRows(OUT, COLUMNS, [row]);
        console.log(
          `${model} ${variant} u1=${row.cached_u1 ?? "-"}/${row.prompt_u1 ?? "-"} A=${row.cached_a1}→${row.cached_a2}/${row.prompt_a} edited=${row.cached_edited}/${row.prompt_edited}${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`
        );
      });
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
