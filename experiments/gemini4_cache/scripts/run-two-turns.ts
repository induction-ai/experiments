/**
 * Question: two conversations open with the same 10,000-token message and
 * reach about 13,000 tokens on turn 2. What does turn 2 cost when the extra
 * 3,000 tokens are your own text, versus the model's reply?
 *
 * Per trial: see src/two-turns.ts (the code the blog shows). One row per
 * trial with both turns' usage and countTokens.
 *
 * The 2,049-token rule predicts: your_text caches turn 1's prompt − 2,049;
 * long_reply (a reply over 2,049 tokens) caches all of turn 1's prompt.
 *
 * Appends RUNS trials per (model, kind) to results/two_turns.csv;
 * FRESH=true wipes it first.
 *
 * APPEND_WORDS ("3000", or a list) sets how much of your own text
 * `your_text` appends, to find where the saved end of turn 1 becomes usable.
 * KINDS limits the kinds run.
 *
 * OPENING_WORDS ("10000", or a list) sets the size of turn 1's message.
 *
 * Env: MODELS (both), KINDS (both), OPENING_WORDS (10000), APPEND_WORDS (3000), RUNS (1),
 * DELAY_MS (3000), CONCURRENCY (4), FRESH.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";
import { KINDS, twoTurns, type Kind } from "../src/two-turns.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/two_turns.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "kind",
  "opening_words",
  "append_words",
  "seed",
  "nonce",
  "prompt_1",
  "cached_1",
  "output_1",
  "counted_1",
  "prompt_2",
  "cached_2",
  "output_2",
  "counted_2",
  "error",
] as const;

const models = process.env.MODELS?.split(",") ?? [...MODELS];
const kinds = (process.env.KINDS?.split(",") ?? [...KINDS]) as Kind[];
const appends = (process.env.APPEND_WORDS ?? "3000").split(",").map(Number);
const openings = (process.env.OPENING_WORDS ?? "10000").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const openingWords of openings) {
      for (const kind of kinds) {
        for (const appendWords of kind === "your_text" ? appends : [0]) {
          tasks.push(async () => {
            const seed = crypto.randomInt(1, 2 ** 31);
            const nonce = crypto.randomBytes(6).toString("hex");
            const row: Record<string, string | number | null | undefined> = {
              timestamp: new Date().toISOString(),
              batch,
              run,
              model,
              kind,
              opening_words: openingWords,
              append_words: kind === "your_text" ? appendWords : null,
              seed,
              nonce,
            };
            try {
              const { turn1, turn2 } = await twoTurns({
                model,
                kind,
                seed,
                nonce,
                delayMs: DELAY_MS,
                openingWords,
                appendWords,
              });
              Object.assign(row, {
                prompt_1: turn1.prompt,
                cached_1: turn1.cached,
                output_1: turn1.output,
                counted_1: turn1.counted,
                prompt_2: turn2.prompt,
                cached_2: turn2.cached,
                output_2: turn2.output,
                counted_2: turn2.counted,
              });
              console.log(
                `${model} ${kind}${kind === "your_text" ? ` +${appendWords}w` : ""}: turn 1 ${turn1.prompt} (reply ${turn1.output}) → turn 2 ${turn2.prompt}, cached ${turn2.cached}, full price ${turn2.prompt - turn2.cached}`
              );
            } catch (e) {
              row.error = String(e).slice(0, 300);
              console.log(`${model} ${kind}: ERR ${row.error}`);
            }
            // Every condition column must be set, so a trial can never land
            // in the CSV without saying what was run (opening_words once didn't).
            for (const c of [
              "model",
              "kind",
              "opening_words",
              "append_words",
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
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
