/**
 * Question: above the threshold, how reliably does an identical repeat hit,
 * and how is cachedContentTokenCount rounded?
 *
 * Per trial: one model, one size (WORDS of filler in a single user message,
 * shape `one`, fresh nonce). The same request is sent SENDS times, DELAY_MS
 * apart. One CSV row per send, so hit rate by send index and the gap between
 * prompt and cached tokens can both be read off.
 *
 * A dependable cache hits on every send after the first. A fixed granularity
 * shows up as cached counts that sit on a lattice (a constant step) whatever
 * the prompt size.
 *
 * ASKS crosses this with the length of the model's reply: `short` asks for
 * one word, `long` for about 3000 words (maxOutputTokens 8192). If stored
 * entries include the generated tokens and the held-back tail comes off
 * prompt + output, a long reply makes the repeat cache the whole prompt;
 * if the tail comes off the prompt alone, both asks hold back the same ~2048.
 *
 * Appends RUNS trials per (model, size, ask) to results/repeats.csv;
 * FRESH=true wipes it first.
 *
 * Env: MODELS (both), WORDS ("8000,16000,32000,64000"), ASKS (short,long),
 * RUNS (1), SENDS (6), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { GENERATION_CONFIG, MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";
import { QUESTION, runThreshold } from "../src/threshold.js";

const ASK = {
  short: { question: QUESTION, generationConfig: GENERATION_CONFIG },
  long: {
    question:
      "Write a story of about 3000 words that uses as many of the words above as you can.",
    generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 8192 },
  },
} as const;
type Ask = keyof typeof ASK;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/repeats.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "trial",
  "model",
  "words",
  "ask",
  "seed",
  "nonce",
  "send",
  "prompt",
  "cached",
  "output",
  "thoughts",
  "model_version",
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
const sizes = list(process.env.WORDS, ["8000", "16000", "32000", "64000"]).map(
  Number
);
const asks = list(process.env.ASKS, ["short", "long"]) as Ask[];
const RUNS = Number(process.env.RUNS ?? 1);
const SENDS = Number(process.env.SENDS ?? 6);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const words of sizes) {
      for (const ask of asks) {
        tasks.push(async () => {
          const seed = crypto.randomInt(1, 2 ** 31);
          const nonce = crypto.randomBytes(6).toString("hex");
          const t = await runThreshold({
            model,
            shape: "one",
            totalWords: words,
            seed,
            nonce,
            repeats: SENDS,
            delayMs: DELAY_MS,
            ...ASK[ask],
          });
          const base = {
            timestamp: new Date().toISOString(),
            batch,
            run,
            trial: nonce,
            model,
            words,
            ask,
            seed,
            nonce,
          };
          const rows: Record<string, string | number | null | undefined>[] =
            t.finals.map((u, send) => ({
              ...base,
              send,
              prompt: u.prompt,
              cached: u.cached,
              output: u.output,
              thoughts: u.thoughts,
              model_version: t.versions[send],
            }));
          if (t.error)
            rows.push({ ...base, send: rows.length, error: t.error });
          appendRows(OUT, COLUMNS, rows);
          console.log(
            `${model} ${words}w ${ask} ${t.finals.map((u) => `${u.cached}/${u.prompt}`).join(" ")}${t.error ? ` ERR ${t.error.slice(0, 100)}` : ""}`
          );
        });
      }
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
