/**
 * Question: on Gemini 4, does turn 1's end breakpoint still exist after turn 2
 * resumed from turn 1's other point?
 *
 * Per trial: src/exact-4100.ts `branchCase`. Turn 1 exactly 4,100 tokens,
 * turn 2 exactly +1,000, then a branch from turn 1 exactly +2,500 (a different
 * new message after turn 1's reply). Control: the same branch without turn 2.
 *
 * The branch (6,600 tokens) can resume up to 4,551. If turn 1's end
 * breakpoint survived turn 2, it caches 4,101 (as the control should). If
 * turn 2 replaced it, it caches turn 2's point 3,051, which lies inside turn 1.
 * OpenAI is the reference: it should cache 4,097 either way.
 *
 * Appends RUNS trials per (provider, variant) to results/exact_branch.csv;
 * FRESH=true wipes it first.
 *
 * Env: OPENAI_MODEL (gpt-5.6-sol), GEMINI_MODEL (gemini-4-argon),
 * PROVIDERS (openai,gemini), RUNS (1), DELAY_MS (3000), CONCURRENCY (4), FRESH.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendRows } from "../src/csv.js";
import { branchCase, gemini, openai } from "../src/exact-4100.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/exact_branch.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "provider",
  "model",
  "variant",
  "append",
  "branch",
  "seed",
  "nonce",
  "prompt_1",
  "cached_1",
  "prompt_2",
  "cached_2",
  "prompt_b",
  "cached_b",
  "error",
] as const;

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-4-argon";
const PROVIDERS = (process.env.PROVIDERS ?? "openai,gemini").split(",");
const RUNS = Number(process.env.RUNS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const APPEND = 1000;
const BRANCH = 2500;

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
    for (const variant of ["after_turn2", "control"] as const) {
      tasks.push(async () => {
        const seed = crypto.randomInt(1, 2 ** 31);
        const nonce = crypto.randomBytes(6).toString("hex");
        const row: Record<string, string | number | null | undefined> = {
          timestamp: new Date().toISOString(),
          batch,
          run,
          provider: name,
          model,
          variant,
          append: APPEND,
          branch: BRANCH,
          seed,
          nonce,
        };
        try {
          const provider =
            name === "openai" ? openai(model, nonce) : gemini(model);
          const r = await branchCase({
            provider,
            append: APPEND,
            branch: BRANCH,
            sendTurn2: variant === "after_turn2",
            seed,
            nonce,
            delayMs: DELAY_MS,
          });
          Object.assign(row, {
            prompt_1: r.turn1.prompt,
            cached_1: r.turn1.cached,
            prompt_2: r.turn2?.prompt,
            cached_2: r.turn2?.cached,
            prompt_b: r.branch.prompt,
            cached_b: r.branch.cached,
          });
          console.log(
            `${name} ${variant}: turn 1 ${r.turn1.prompt}${r.turn2 ? ` → turn 2 ${r.turn2.prompt} (cached ${r.turn2.cached})` : ""} → branch ${r.branch.prompt} (cached ${r.branch.cached})`
          );
        } catch (e) {
          row.error = String(e).slice(0, 300);
          console.log(`${name} ${variant}: ERR ${row.error.slice(0, 100)}`);
        }
        for (const c of [
          "provider",
          "model",
          "variant",
          "append",
          "branch",
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
