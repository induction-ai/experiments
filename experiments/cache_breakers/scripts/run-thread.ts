/**
 * Question: in a real multi-turn thread, is an edit or branch in the middle
 * reusable only up to the end of an earlier request, or up to the edit (any
 * message boundary / longest prefix, as OpenAI documents for older models)?
 *
 * Per trial: send a 6-turn thread one request at a time (request k is
 * u1, a1, …, uk; assistant replies are fixed ~500-word text), then one probe:
 *   edit_u4            edit user message 4 in the full thread
 *   branch_at_u4       u1..a3 then a different u4 (changing the thread)
 *   truncate_after_a4  u1..a4 then a new user message
 *   edit_u4_after_60s  as edit_u4, after a 60 s pause (asynchronous storage?)
 *
 * Reading: the thread measures each request's reusable end (request k+1
 * reads all of request k). If the probe's cached count equals the end of the
 * last intact request, only request ends are reusable. If it lands past it
 * (into the following assistant reply, up to the edit), the cache matches a
 * longer prefix. The replies are long so the two differ by hundreds of
 * tokens.
 *
 * Appends RUNS trials per probe to results/thread/<adapter>.csv; FRESH=true
 * wipes it.
 *
 * Env: PROVIDER (openai_responses | openai_responses_gpt-5.5 |
 * anthropic_auto | anthropic_breakpoints: tools, system and each request's
 * last message marked), MODEL (adapter
 * default), PROBES (all), RUNS (1), TURNS (6), USER_WORDS (150),
 * REPLY_WORDS (500), CONCURRENCY (4), DELAY_MS (1500), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { ADAPTERS } from "../src/providers/index.js";
import { runThread, THREAD_PROBES, type ThreadProbe } from "../src/thread.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "probe",
  "seed",
  "nonce",
  "turns",
  "request_tokens",
  "request_cached",
  "predict_request_end",
  "next_request_end",
  "probe_input",
  "probe_cached",
  "error",
];

const env = process.env;
const providerName = env.PROVIDER ?? "openai_responses";
const adapter = ADAPTERS[providerName];
if (!adapter) throw new Error(`Unknown PROVIDER ${providerName}`);
const model = env.MODEL ?? adapter.defaultModel;
const OUT = path.join(here, `../results/thread/${adapter.name}.csv`);
const probes = (env.PROBES?.split(",") ?? [...THREAD_PROBES]) as ThreadProbe[];
const runs = Number(env.RUNS ?? 1);

if (env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const jobs = Array.from({ length: runs }, (_, run) =>
  probes.map((probe) => ({ run, probe }))
).flat();
console.log(`thread ${providerName} ${model}: ${jobs.length} trials`);

let next = 0;
const worker = async () => {
  while (next < jobs.length) {
    const { run, probe } = jobs[next++]!;
    const row = await runThread(adapter, probe, {
      model,
      seed: crypto.randomInt(2 ** 31),
      nonce: crypto.randomBytes(6).toString("hex"),
      turns: Number(env.TURNS ?? 6),
      userWords: Number(env.USER_WORDS ?? 150),
      replyWords: Number(env.REPLY_WORDS ?? 500),
      delayMs: Number(env.DELAY_MS ?? 1500),
    });
    appendRows(OUT, COLUMNS, [
      { ...row, batch, run, timestamp: new Date().toISOString() },
    ]);
    console.log(
      `${probe}: ${row.error ? `ERROR ${row.error.slice(0, 70)}` : `cached ${row.probe_cached}, request-end rule ${row.predict_request_end}, next request end ${row.next_request_end}; thread reads ${row.request_cached}`}`
    );
  }
};
await Promise.all(Array.from({ length: Number(env.CONCURRENCY ?? 4) }, worker));
console.log(`wrote ${OUT}`);
