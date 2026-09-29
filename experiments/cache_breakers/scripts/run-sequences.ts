/**
 * Question: does the engine behind the blog's thread builder (src/engine.ts,
 * rules from the static results) predict real threads that stack several
 * changes, when every rule in it was measured one change at a time?
 *
 * Per trial: a random thread of reader actions (src/threads.ts: next turn,
 * edits to the tools, system prompt or any message, branch, cut, resend,
 * setting changes), STEPS requests long, sent one at a time. Before each
 * request, the engine predicts its cache read from the thread so far, with
 * every part sized by the provider's token-count endpoint. The row records
 * the prediction next to the read.
 *
 * Reading: a prediction agrees when it is within max(40, 1.5%) tokens of
 * the read; counts and billed input differ by a few tokens, hence the
 * tolerance.
 *
 * Appends one row per request to results/sequences/<adapter>.csv;
 * FRESH=true wipes it.
 *
 * Env: PROVIDER (openai_responses | openai_responses_gpt-6-luna |
 * anthropic_auto | anthropic_breakpoints), MODEL (adapter default),
 * RUNS (1), STEPS (10), CONCURRENCY (4), DELAY_MS (1500), FRESH (false),
 * ACTIONS (a scripted thread instead of random actions, `;`-separated:
 * "next;set summary=on"), OUT_NAME (results file, default the adapter).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toObs } from "../src/analyze.js";
import { appendRows, parseCsv } from "../src/csv.js";
import { ADAPTERS } from "../src/providers/index.js";
import { buildRules } from "../src/rules.js";
import { parseAction, runSequence } from "../src/sequence.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "seed",
  "nonce",
  "step",
  "action",
  "params",
  "input",
  "cached",
  "predicted",
  "predicted_from",
  "predicted_unknown",
  "counted",
  "error",
];

const env = process.env;
const providerName = env.PROVIDER ?? "openai_responses";
const adapter = ADAPTERS[providerName];
if (!adapter) throw new Error(`Unknown PROVIDER ${providerName}`);
const staticDir = path.join(here, "../results/static");
const rules = buildRules(
  fs
    .readdirSync(staticDir)
    .filter((f) => f.endsWith(".csv"))
    .flatMap((f) => parseCsv(fs.readFileSync(path.join(staticDir, f), "utf8")))
    .map(toObs)
)[providerName];
if (!rules) throw new Error(`No engine rules for ${providerName}`);

const model = env.MODEL ?? adapter.defaultModel;
const OUT = path.join(
  here,
  `../results/sequences/${env.OUT_NAME ?? adapter.name}.csv`
);
const actions = env.ACTIONS?.split(";").map(parseAction);
const runs = Number(env.RUNS ?? 1);
if (env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
console.log(`sequences ${providerName} ${model}: ${runs} threads`);

let next = 0;
const worker = async () => {
  while (next < runs) {
    const run = next++;
    const rows = await runSequence(adapter, rules, {
      model,
      seed: crypto.randomInt(2 ** 31),
      nonce: crypto.randomBytes(6).toString("hex"),
      steps: Number(env.STEPS ?? 10),
      delayMs: Number(env.DELAY_MS ?? 1500),
      actions,
    });
    appendRows(
      OUT,
      COLUMNS,
      rows.map((r) => ({ ...r, batch, run, timestamp: new Date().toISOString() }))
    );
    for (const r of rows) {
      const ok =
        r.cached !== null &&
        r.predicted !== null &&
        Math.abs(r.cached - r.predicted) <= Math.max(40, 0.015 * (r.input ?? 0));
      console.log(
        `[${run}.${r.step}] ${r.action.padEnd(24)} ${r.error ? `ERROR ${r.error.slice(0, 80)}` : `read ${r.cached}/${r.input}, predicted ${r.predicted}${r.predicted_unknown ? " (unmeasured)" : ""} ${ok ? "" : "  <-- differs"}`}`
      );
    }
  }
};
await Promise.all(Array.from({ length: Number(env.CONCURRENCY ?? 4) }, worker));
console.log(`wrote ${OUT}`);
