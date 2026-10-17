/**
 * Question: is the uncached tail of an identical repeat a fixed number of
 * tokens (argon: 2049 in every earlier probe), or does it depend on the
 * content, the thinking level, where the content sits, or the size?
 *
 * Per trial: see src/tail.ts. One factor changes from the baseline per
 * variant; the same request is sent twice; tail = prompt − cached on the
 * second send. One row per trial.
 *
 * A fixed constant shows the same tail in every variant. Any variant with a
 * different tail refutes "fixed" and shows what it depends on.
 *
 * Appends RUNS trials per (model, variant) to results/tail.csv; FRESH=true
 * wipes it first.
 *
 * Env: MODELS (both), VARIANTS (all), TOKENS (8000), LARGE_TOKENS (128000),
 * RUNS (1), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";
import { runTail, TAIL_VARIANTS, type TailVariant } from "../src/tail.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/tail.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "variant",
  "target_tokens",
  "seed",
  "nonce",
  "prompt_1",
  "cached_1",
  "prompt_2",
  "cached_2",
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
const variants = list(process.env.VARIANTS, TAIL_VARIANTS) as TailVariant[];
const TOKENS = Number(process.env.TOKENS ?? 8000);
const LARGE_TOKENS = Number(process.env.LARGE_TOKENS ?? 128000);
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
        const tokens = variant === "large" ? LARGE_TOKENS : TOKENS;
        const t = await runTail({
          model,
          variant,
          tokens,
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
          target_tokens: tokens,
          seed,
          nonce,
          prompt_1: t.prompts[0],
          cached_1: t.cached[0],
          prompt_2: t.prompts[1],
          cached_2: t.cached[1],
          error: t.error,
        };
        appendRows(OUT, COLUMNS, [row]);
        const tail =
          t.prompts[1] !== undefined ? t.prompts[1] - t.cached[1]! : "-";
        console.log(
          `${model} ${variant} prompt=${t.prompts[1] ?? "-"} cached=${t.cached[1] ?? "-"} tail=${tail}${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`
        );
      });
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
