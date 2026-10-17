/**
 * Question: which requests does gemini-4-argon bill hidden extra prompt
 * tokens for, and does a one-word change to the end of the request flip it?
 *
 * Per trial: see src/inflation.ts. Inflation = promptTokenCount − countTokens.
 * One row per trial with both sends.
 *
 * If the extra tokens depend on the request's shape or size, the inflated
 * share differs by cell; if they come from the content, it is similar across
 * cells, and a one-word change flips it in some trials. If a system
 * instruction suppresses them, `short` cells show none.
 *
 * Appends RUNS trials per (model, shape, words, system) to
 * results/inflation.csv; FRESH=true wipes it first.
 *
 * Env: MODELS (gemini-4-argon), SHAPES (one,two_cold,many_cold), WORDS
 * ("4000,16000"), SYSTEMS (none,short), RUNS (1), DELAY_MS (1500),
 * CONCURRENCY (6), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import {
  INFLATION_SHAPES,
  runInflation,
  SYSTEMS,
  type System,
} from "../src/inflation.js";
import { pool } from "../src/pool.js";
import type { Shape } from "../src/threshold.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/inflation.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "shape",
  "words",
  "system",
  "seed",
  "nonce",
  "prompt_ok",
  "counted_ok",
  "prompt_yes",
  "counted_yes",
  "cached_yes",
  "error",
] as const;

const list = (v: string | undefined, d: readonly string[]) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...d];

const models = list(process.env.MODELS, ["gemini-4-argon"]);
const shapes = list(process.env.SHAPES, INFLATION_SHAPES) as Shape[];
const sizes = list(process.env.WORDS, ["4000", "16000"]).map(Number);
const systems = list(process.env.SYSTEMS, SYSTEMS) as System[];
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 1500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const shape of shapes) {
      for (const words of sizes) {
        for (const system of systems) {
          tasks.push(async () => {
            const seed = crypto.randomInt(1, 2 ** 31);
            const nonce = crypto.randomBytes(6).toString("hex");
            let t;
            try {
              t = await runInflation({
                model,
                shape,
                words,
                system,
                seed,
                nonce,
                delayMs: DELAY_MS,
              });
            } catch (e) {
              t = { sends: [], error: String(e) };
            }
            const [ok, yes] = t.sends;
            const row = {
              timestamp: new Date().toISOString(),
              batch,
              run,
              model,
              shape,
              words,
              system,
              seed,
              nonce,
              prompt_ok: ok?.prompt,
              counted_ok: ok?.counted,
              prompt_yes: yes?.prompt,
              counted_yes: yes?.counted,
              cached_yes: yes?.cached,
              error: t.error,
            };
            appendRows(OUT, COLUMNS, [row]);
            const inf = (s?: { prompt: number; counted: number }) =>
              s ? s.prompt - s.counted : "-";
            console.log(
              `${model} ${shape} ${words}w ${system} inflation ok=${inf(ok)} yes=${inf(yes)}${t.error ? ` ERR ${t.error.slice(0, 120)}` : ""}`
            );
          });
        }
      }
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
