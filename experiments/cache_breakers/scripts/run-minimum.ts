/**
 * Question: what is the smallest prompt the implicit cache will store, and
 * the smallest header (tools + instructions) it will reuse as a checkpoint?
 *
 * Per trial, one of two probes at a given size (WORDS of filler, tagged with a
 * fresh nonce):
 *   whole:  one prompt (instructions + a tiny user message) sent up to
 *           MAX_CALLS times; hit = any repeat reports cached tokens.
 *   header: a request with an n-word system prompt and a large history is
 *           warmed, then its final message is edited; hit = the edit keeps
 *           the header. A header-only request, sent last, gives its size.
 * Each row records the tokens of the request under test (`size_tokens`) and
 * the cached count, so the threshold is read off in tokens: the largest
 * size with no hit and the smallest size with one.
 *
 * Confirms a documented minimum (1024 for OpenAI) if hits start exactly
 * there for both probes; a different or probe-dependent threshold refutes it.
 *
 * Appends RUNS trials per size and probe to results/minimum/<adapter>.csv;
 * FRESH=true wipes that file. Sizes: WORDS="a,b,c" or MIN_WORDS..MAX_WORDS by STEP.
 *
 * Env: PROVIDER (openai_responses), MODEL (adapter default), PROBES
 * (whole,header), RUNS (1), WORDS | MIN_WORDS (400) MAX_WORDS (2000) STEP
 * (100), HISTORY_WORDS (1500), MAX_CALLS (3), CONCURRENCY (6), DELAY_MS
 * (1500), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { runMinimum, type MinimumProbe } from "../src/minimum.js";
import { ADAPTERS } from "../src/providers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "probe",
  "words",
  "seed",
  "nonce",
  "size_tokens",
  "calls",
  "cached",
  "error",
];

const env = process.env;
const providerName = env.PROVIDER ?? "openai_responses";
const adapter = ADAPTERS[providerName];
if (!adapter) throw new Error(`Unknown PROVIDER ${providerName}`);
const model = env.MODEL ?? adapter.defaultModel;
const OUT = path.join(here, `../results/minimum/${adapter.name}.csv`);
const runs = Number(env.RUNS ?? 1);
const probes = (env.PROBES ?? "whole,header").split(",") as MinimumProbe[];
const sizes = env.WORDS
  ? env.WORDS.split(",").map(Number)
  : (() => {
      const [lo, hi, step] = [
        Number(env.MIN_WORDS ?? 400),
        Number(env.MAX_WORDS ?? 2000),
        Number(env.STEP ?? 100),
      ];
      const out: number[] = [];
      for (let w = lo; w <= hi; w += step) out.push(w);
      return out;
    })();

if (env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const jobs = Array.from({ length: runs }, (_, run) =>
  probes.flatMap((probe) => sizes.map((words) => ({ run, probe, words })))
).flat();
console.log(`minimum ${providerName} ${model}: ${jobs.length} trials`);

let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const { run, probe, words } = jobs[next++]!;
    const row = await runMinimum(adapter, probe, {
      model,
      words,
      seed: crypto.randomInt(2 ** 31),
      nonce: crypto.randomBytes(6).toString("hex"),
      maxCalls: Number(env.MAX_CALLS ?? 3),
      delayMs: Number(env.DELAY_MS ?? 1500),
      historyWords: Number(env.HISTORY_WORDS ?? 1500),
    });
    appendRows(OUT, COLUMNS, [
      { ...row, batch, run, timestamp: new Date().toISOString() },
    ]);
    console.log(
      `${probe} ${words}w: ${row.error ? `ERROR ${row.error.slice(0, 60)}` : `size ${row.size_tokens} cached ${row.cached}`}`
    );
  }
};
await Promise.all(Array.from({ length: Number(env.CONCURRENCY ?? 6) }, worker));
console.log(`wrote ${OUT}`);
