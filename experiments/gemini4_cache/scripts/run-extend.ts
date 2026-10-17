/**
 * Question: in a thread where every request is sent exactly once, how
 * reliably does each request reuse the cache entry the previous one left,
 * for plain text turns and for an agent loop of signed function calls?
 *
 * Per trial: see src/extend.ts. Step 0 is WORDS of filler in one user
 * message; each later step appends the model's real reply and a short user
 * message. One CSV row per step.
 *
 * A dependable prefix cache makes every step k ≥ 1 cache about the previous
 * step's prompt minus the held-back tail. If signatures cap reuse,
 * `tool_chain` steps will cache well below that while `text_chain` steps
 * don't. If extensions are unreliable in general, both miss at a similar rate.
 *
 * Appends RUNS trials per (model, chain) to results/extend.csv; FRESH=true
 * wipes it first.
 *
 * `long_chain` (step 0's reply is thousands of tokens) tells apart two rules
 * for the held-back tail: if it comes off the new request, step 1 caches
 * about step 0's whole prompt; if each entry covers prompt + output minus the
 * tail, step 1 caches about step 0's prompt + output − ~2049.
 *
 * `mid_chain` (a ~700-word story) and `para_chain` (40 numbered paragraphs,
 * ~3600 tokens on both models) put step 0's reply under and over that tail.
 *
 * Env: MODELS (both), CHAINS (all five), WORDS (20000),
 * STEPS (6), RUNS (1), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { CHAINS, runExtend, type Chain } from "../src/extend.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/extend.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "trial",
  "model",
  "chain",
  "words",
  "seed",
  "nonce",
  "step",
  "prompt",
  "cached",
  "reply_kind",
  "reply_sig_bytes",
  "output",
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
const chains = list(process.env.CHAINS, CHAINS) as Chain[];
const WORDS = Number(process.env.WORDS ?? 20000);
const STEPS = Number(process.env.STEPS ?? 6);
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const model of models) {
    for (const chain of chains) {
      tasks.push(async () => {
        const seed = crypto.randomInt(1, 2 ** 31);
        const nonce = crypto.randomBytes(6).toString("hex");
        const t = await runExtend({
          model,
          chain,
          words: WORDS,
          steps: STEPS,
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
          chain,
          words: WORDS,
          seed,
          nonce,
        };
        const rows: Record<string, string | number | null | undefined>[] =
          t.steps.map((s) => ({
            ...base,
            step: s.step,
            prompt: s.prompt,
            cached: s.cached,
            reply_kind: s.replyKind,
            reply_sig_bytes: s.replySigBytes,
            output: s.output,
            model_version: s.modelVersion,
          }));
        if (t.error) rows.push({ ...base, step: rows.length, error: t.error });
        appendRows(OUT, COLUMNS, rows);
        console.log(
          `${model} ${chain} ${t.steps.map((s) => `${s.cached}/${s.prompt}`).join(" ")}${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`
        );
      });
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
