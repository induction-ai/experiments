/**
 * Question: once an agent loop is extended past a model function-call turn,
 * does that turn's thoughtSignature cap the cached prefix at its position?
 * And does countTokens agree with generateContent's promptTokenCount?
 *
 * Per trial: see src/sig.ts. A (warm, sent twice) is a strict prefix of C, so
 * a pure byte-prefix cache reuses all of A on C's first send.
 *
 * Confirms "the signature caps the cache" if C's first send caches about the
 * tokens before the signature (pre_prompt, rounded down to the cache's
 * granularity) rather than about A's cached amount, and the `text` control
 * keeps all of A. Refuted if `sig` keeps A as well as `text` does.
 * For countTokens: compare ct_c − ct_a with prompt_c − prompt_a.
 *
 * Appends RUNS trials per (model, variant) to results/sig.csv; FRESH=true
 * wipes it first.
 *
 * Env: MODELS (both), VARIANTS (sig,text), RUNS (1), PRE_WORDS (18000),
 * POST_WORDS (5000), DELAY_MS (3000), CONCURRENCY (4), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { MODELS } from "../src/gemini.js";
import { pool } from "../src/pool.js";
import { runSig, SIG_VARIANTS, type SigVariant } from "../src/sig.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/sig.csv");

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
  "pre_prompt",
  "cached_0",
  "sig_bytes",
  "prompt_a",
  "cached_a1",
  "cached_a2",
  "m2_kind",
  "m2_sig_bytes",
  "prompt_c",
  "cached_c1",
  "cached_c2",
  "ct_a",
  "ct_c",
  "ct_a_nosig",
  "ct_error",
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
const variants = list(process.env.VARIANTS, SIG_VARIANTS) as SigVariant[];
const RUNS = Number(process.env.RUNS ?? 1);
const PRE_WORDS = Number(process.env.PRE_WORDS ?? 18000);
const POST_WORDS = Number(process.env.POST_WORDS ?? 5000);
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
        let t;
        try {
          t = await runSig({
            model,
            variant,
            preWords: PRE_WORDS,
            postWords: POST_WORDS,
            seed,
            nonce,
            delayMs: DELAY_MS,
          });
        } catch (e) {
          t = { error: String(e) } as Awaited<ReturnType<typeof runSig>>;
          t.a = [];
          t.c = [];
        }
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
          pre_prompt: t.prePrompt,
          cached_0: t.cached0,
          sig_bytes: t.sigBytes,
          prompt_a: t.a[0]?.prompt,
          cached_a1: t.a[0]?.cached,
          cached_a2: t.a[1]?.cached,
          m2_kind: t.m2Kind,
          m2_sig_bytes: t.m2SigBytes,
          prompt_c: t.c[0]?.prompt,
          cached_c1: t.c[0]?.cached,
          cached_c2: t.c[1]?.cached,
          ct_a: t.ctA,
          ct_c: t.ctC,
          ct_a_nosig: t.ctANoSig,
          ct_error: t.ctError,
          model_versions: t.versions?.join(";"),
          error: t.error,
        };
        appendRows(OUT, COLUMNS, [row]);
        console.log(JSON.stringify(row));
      });
    }
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
