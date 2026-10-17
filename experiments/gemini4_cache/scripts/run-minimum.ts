/**
 * Question: what is the smallest request each model will cache, and does it
 * depend on the shape of the history (how many messages carry the tokens, and
 * whether the thread grew turn by turn) rather than on total size alone?
 *
 * Per trial: one model, one total size (WORDS of filler) and one shape (see
 * src/threshold.ts). For `*_grown` shapes the thread's earlier turns are sent
 * first, once each; then the final request is sent REPEATS times. Hit = any
 * send of the final request reports cachedContentTokenCount > 0.
 *
 * If the threshold is a size limit only, every shape flips from miss to hit at
 * the same final-request size. If history matters, `*_grown` shapes hit at
 * sizes where `one` / `*_cold` miss (or the reverse).
 *
 * Appends RUNS trials per (model, size, shape) to results/minimum.csv;
 * FRESH=true wipes it first.
 *
 * Env: MODELS (both), SHAPES (all), WORDS ("1000,2000,...") , RUNS (1),
 * REPEATS (3), DELAY_MS (3000), CONCURRENCY (6), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";
import { pieces, runThreshold, SHAPES, type Shape } from "../src/threshold.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/minimum.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "shape",
  "pieces",
  "words",
  "seed",
  "nonce",
  "warmup_prompts",
  "prompt",
  "prompts_all",
  "cached_first",
  "cached_max",
  "cached_all",
  "model_versions",
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
const shapes = list(process.env.SHAPES, SHAPES) as Shape[];
const sizes = list(process.env.WORDS, [
  "1000",
  "2000",
  "3000",
  "4000",
  "5000",
  "6000",
  "8000",
  "10000",
  "12000",
]).map(Number);
const RUNS = Number(process.env.RUNS ?? 1);
const REPEATS = Number(process.env.REPEATS ?? 3);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const words of sizes) {
      for (const shape of shapes) {
        tasks.push(async () => {
          const seed = crypto.randomInt(1, 2 ** 31);
          const nonce = crypto.randomBytes(6).toString("hex");
          const t = await runThreshold({
            model,
            shape,
            totalWords: words,
            seed,
            nonce,
            repeats: REPEATS,
            delayMs: DELAY_MS,
          });
          const cached = t.finals.map((u) => u.cached);
          const row = {
            timestamp: new Date().toISOString(),
            batch,
            run,
            model,
            shape,
            pieces: pieces(shape),
            words,
            seed,
            nonce,
            warmup_prompts: t.warmupPrompts.join(";"),
            prompt: t.finals[0]?.prompt,
            prompts_all: t.finals.map((u) => u.prompt).join(";"),
            cached_first: cached[0],
            cached_max: cached.length ? Math.max(...cached) : undefined,
            cached_all: cached.join(";"),
            model_versions: [...new Set(t.versions)].join(";"),
            error: t.error,
          };
          appendRows(OUT, COLUMNS, [row]);
          console.log(
            `${model} ${shape} ${words}w prompt=${row.prompt} cached=${row.cached_all}${t.error ? ` ERR ${t.error.slice(0, 120)}` : ""}`
          );
        });
      }
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
