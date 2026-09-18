import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendRows } from "./csv.js";
import { ADAPTERS } from "./providers/index.js";
import type { Variant } from "./providers/types.js";
import { runTrial, type Scenario, type TrialRow } from "./trial.js";

export type Column = keyof TrialRow | "batch" | "run" | "timestamp";

export const BASE_COLUMNS: Column[] = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "variant",
  "group",
  "seed",
  "nonce",
  "section_words",
  "first_cached",
  "warm_attempts",
  "warmed",
  "base_input",
  "base_cached",
  "status",
  "error",
  "input",
  "cached",
  "cache_write",
  "output",
  "reasoning",
];

/**
 * Run RUNS trials of every selected variant and append one row per trial to
 * `out`. Reads its knobs from the environment (see the scripts' headers).
 */
export async function runFromEnv(opts: {
  scenario: Scenario;
  /** Directory for this scenario; each adapter appends to `<dir>/<adapter>.csv`. */
  dir: string;
  columns: Column[];
}): Promise<void> {
  const env = process.env;
  const providerName = env.PROVIDER ?? "openai_responses";
  const adapter = ADAPTERS[providerName];
  if (!adapter) throw new Error(`Unknown PROVIDER ${providerName}`);
  const all: Variant[] =
    opts.scenario === "tool_loop"
      ? (adapter.toolLoop?.variants ?? [])
      : adapter.variants;
  if (all.length === 0) {
    throw new Error(`${providerName} has no ${opts.scenario} scenario`);
  }
  const model = env.MODEL ?? adapter.defaultModel;
  const runs = Number(env.RUNS ?? 1);
  const sectionWords = Number(env.SECTION_WORDS ?? 1500);
  const concurrency = Number(env.CONCURRENCY ?? 4);
  const delayMs = Number(env.DELAY_MS ?? 1500);
  const maxWarm = Number(env.MAX_WARM ?? 4);
  const only = env.VARIANTS?.split(",").map((s) => s.trim());
  const variants = only ? all.filter((v) => only.includes(v.name)) : all;
  if (only && variants.length !== only.length) {
    const known = new Set(all.map((v) => v.name));
    throw new Error(
      `Unknown variants: ${only.filter((n) => !known.has(n)).join(", ")}`
    );
  }

  const out = path.join(opts.dir, `${adapter.name}.csv`);
  if (env.FRESH === "true" && fs.existsSync(out)) fs.rmSync(out);
  fs.mkdirSync(opts.dir, { recursive: true });

  const batch = new Date().toISOString();
  const jobs = Array.from({ length: runs }, (_, run) =>
    variants.map((variant) => ({ run, variant }))
  ).flat();
  console.log(
    `${opts.scenario} ${providerName} ${model}: ${variants.length} variants x ${runs} runs = ${jobs.length} trials`
  );

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { run, variant } = jobs[next++]!;
      const seed = crypto.randomInt(2 ** 31);
      const nonce = crypto.randomBytes(6).toString("hex");
      let row: TrialRow;
      try {
        row = await runTrial(
          adapter,
          variant,
          { seed, nonce, model, sectionWords, maxWarm, delayMs },
          opts.scenario
        );
      } catch (e) {
        console.error(`${variant.name} run ${run}: ${String(e)}`);
        continue;
      }
      appendRows(out, opts.columns, [
        { ...row, batch, run, timestamp: new Date().toISOString() },
      ]);
      done++;
      const tail = row.error
        ? `ERROR ${row.error.slice(0, 80)}`
        : `cached ${row.cached}/${row.input} (base ${row.base_cached})`;
      console.log(`[${done}/${jobs.length}] ${variant.name}: ${tail}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`wrote ${out}`);
}
