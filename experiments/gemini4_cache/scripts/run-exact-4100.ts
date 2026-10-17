/**
 * Question: after an exactly 4,100-token request, what does the next request
 * cost when exactly 1,000 (or 2,100) more tokens are appended, on OpenAI and
 * on Gemini?
 *
 * Per trial: see src/exact-4100.ts. One row per trial with the billed prompt
 * and cached counts of both turns.
 *
 * The expectation "turn 2 caches all 4,100 and pays full price for the
 * rest" holds where a provider's reusable point sits at the exact end of
 * each request. Gemini's 2,049 rule predicts 2,051 cached / 3,049 full price
 * for +1,000, and 4,100 / 1,000 → 4,101 cached / 2,099 full price for +2,100.
 *
 * Appends RUNS trials per (provider, append) to results/exact_4100.csv;
 * FRESH=true wipes it first.
 *
 * TURN1S ("4100", or a list such as "4000,4100") sets turn 1's exact size.
 *
 * Env: OPENAI_MODEL (gpt-5.6-sol), GEMINI_MODEL (gemini-4-argon), TURN1S, RUNS (1),
 * DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import {
  APPENDS,
  exactCase,
  gemini,
  openai,
  TURN1,
} from "../src/exact-4100.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/exact_4100.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "turn1",
  "append",
  "seed",
  "nonce",
  "prompt_1",
  "cached_1",
  "prompt_2",
  "cached_2",
  "error",
] as const;

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-4-argon";
const turn1s = (process.env.TURN1S ?? String(TURN1)).split(",").map(Number);
const appendsRun = (process.env.APPENDS ?? APPENDS.join(","))
  .split(",")
  .map(Number);
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const [name, model] of [
    ["openai", OPENAI_MODEL],
    ["gemini", GEMINI_MODEL],
  ] as const) {
    for (const turn1 of turn1s) {
      for (const append of appendsRun) {
        tasks.push(async () => {
          const seed = crypto.randomInt(1, 2 ** 31);
          const nonce = crypto.randomBytes(6).toString("hex");
          const row: Record<string, string | number | null | undefined> = {
            timestamp: new Date().toISOString(),
            batch,
            run,
            provider: name,
            model,
            turn1,
            append,
            seed,
            nonce,
          };
          try {
            const provider =
              name === "openai" ? openai(model, nonce) : gemini(model);
            const r = await exactCase({
              provider,
              turn1,
              append,
              seed,
              nonce,
              delayMs: DELAY_MS,
            });
            // The billed sizes must be the ones asked for; a mismatch means
            // the fitting or a parameter went wrong, not a cache result.
            if (r.turn1.prompt !== turn1 && name === "openai") {
              throw new Error(
                `turn 1 billed ${r.turn1.prompt}, expected ${turn1}`
              );
            }
            Object.assign(row, {
              prompt_1: r.turn1.prompt,
              cached_1: r.turn1.cached,
              prompt_2: r.turn2.prompt,
              cached_2: r.turn2.cached,
            });
            console.log(
              `${name} ${turn1} +${append}: turn 1 ${r.turn1.prompt} → turn 2 ${r.turn2.prompt}, cached ${r.turn2.cached}, full price ${r.turn2.prompt - r.turn2.cached}`
            );
          } catch (e) {
            row.error = String(e).slice(0, 300);
            console.log(`${name} ${turn1} +${append}: ERR ${row.error}`);
          }
          for (const c of [
            "provider",
            "model",
            "turn1",
            "append",
            "seed",
            "nonce",
          ]) {
            if (!(c in row)) throw new Error(`row is missing ${c}`);
          }
          appendRows(OUT, COLUMNS, [row]);
        });
      }
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
