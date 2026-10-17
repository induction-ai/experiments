/**
 * Question: when the exact 4,100-token chains get a third request, exactly
 * APPEND3 (1,500) tokens more than turn 2, where does turn 3 resume?
 *
 * Per trial: src/exact-4100.ts with `append3`: turn 1 exactly 4,100 tokens,
 * turn 2 exactly 1,000 or 2,500 more, turn 3 exactly 1,500 more again.
 *
 * Gemini 4's rule (every request leaves breakpoints at its end and 2,049
 * before it; a request can't resume inside its own last 2,049) predicts:
 *   +1,000 then +1,500  turn 3 (6,600) can resume up to 4,551, so it uses
 *                       turn 1's end (4,101) if argon still keeps it, ahead
 *                       of turn 2's 3,051.
 *   +2,100 then +1,500  turn 3 (7,700) can resume up to 5,651: turn 2's
 *                       point 2,049 before its end, 4,151.
 * OpenAI resumes at turn 2's end (minus the reply marker): 5,097 and 6,197.
 *
 * Appends RUNS trials per (provider, append) to results/exact_turn3.csv;
 * FRESH=true wipes it first.
 *
 * TURN1 (4100), APPENDS ("1000,2100") and PROVIDERS ("openai,gemini") pick
 * the cells to run.
 *
 * Env: OPENAI_MODEL (gpt-5.6-sol), GEMINI_MODEL (gemini-4-argon), APPEND3
 * (1500), RUNS (1), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
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
const OUT = path.join(here, "../results/exact_turn3.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "turn1",
  "append",
  "append3",
  "seed",
  "nonce",
  "prompt_1",
  "cached_1",
  "prompt_2",
  "cached_2",
  "prompt_3",
  "cached_3",
  "error",
] as const;

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-4-argon";
const APPEND3 = Number(process.env.APPEND3 ?? 1500);
const SIZE1 = Number(process.env.TURN1 ?? TURN1);
const APPENDS_RUN = (process.env.APPENDS ?? APPENDS.join(","))
  .split(",")
  .map(Number);
const PROVIDERS = (process.env.PROVIDERS ?? "openai,gemini").split(",");
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const [name, model] of (
    [
      ["openai", OPENAI_MODEL],
      ["gemini", GEMINI_MODEL],
    ] as const
  ).filter(([n]) => PROVIDERS.includes(n))) {
    for (const append of APPENDS_RUN) {
      tasks.push(async () => {
        const seed = crypto.randomInt(1, 2 ** 31);
        const nonce = crypto.randomBytes(6).toString("hex");
        const row: Record<string, string | number | null | undefined> = {
          timestamp: new Date().toISOString(),
          batch,
          run,
          provider: name,
          model,
          turn1: SIZE1,
          append,
          append3: APPEND3,
          seed,
          nonce,
        };
        try {
          const provider =
            name === "openai" ? openai(model, nonce) : gemini(model);
          const r = await exactCase({
            provider,
            turn1: SIZE1,
            append,
            append3: APPEND3,
            seed,
            nonce,
            delayMs: DELAY_MS,
          });
          Object.assign(row, {
            prompt_1: r.turn1.prompt,
            cached_1: r.turn1.cached,
            prompt_2: r.turn2.prompt,
            cached_2: r.turn2.cached,
            prompt_3: r.turn3?.prompt,
            cached_3: r.turn3?.cached,
          });
          console.log(
            `${name} +${append} +${APPEND3}: ${r.turn1.prompt} → ${r.turn2.prompt} (cached ${r.turn2.cached}) → ${r.turn3?.prompt} (cached ${r.turn3?.cached})`
          );
        } catch (e) {
          row.error = String(e).slice(0, 300);
          console.log(
            `${name} +${append} +${APPEND3}: ERR ${row.error.slice(0, 120)}`
          );
        }
        for (const c of [
          "provider",
          "model",
          "turn1",
          "append",
          "append3",
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
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
