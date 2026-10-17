/**
 * Question: on a warm gemini-4-argon request, which single changes keep the
 * cache and which throw it away? (The cache_breakers matrix, for Gemini.)
 *
 * Per trial: see src/breakers.ts. The base is warmed (up to MAX_WARM sends),
 * optional prewarm requests are sent, then the variant once. One row per
 * trial, with countTokens for base and variant so a change in argon's hidden
 * block can be told apart from the change itself.
 *
 * Expected from the other probes: argon reuses an entry only when the new
 * request starts with a whole earlier request, so any content edit loses
 * everything and appending a turn keeps it. The open questions are the
 * fields that aren't content: generation config, toolConfig, safety
 * settings. If a field is part of the cache key, changing it loses
 * everything; if not, the variant keeps the base's cached count.
 *
 * Appends RUNS trials per variant to results/breakers.csv; FRESH=true wipes
 * it first.
 *
 * Env: MODEL (gemini-4-argon), VARIANTS (all), RUNS (1), MAX_WARM (3),
 * DELAY_MS (3000), CONCURRENCY (6), FRESH (false).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BREAKERS, runBreaker } from "../src/breakers.js";
import { appendRows } from "../src/csv.js";
import { pool } from "../src/pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../results/breakers.csv");

export const COLUMNS = [
  "timestamp",
  "batch",
  "run",
  "model",
  "variant",
  "group",
  "seed",
  "nonce",
  "warm_sends",
  "base_prompt",
  "base_cached",
  "base_counted",
  "prompt",
  "cached",
  "counted",
  "error",
] as const;

const MODEL = process.env.MODEL ?? "gemini-4-argon";
const only = process.env.VARIANTS?.split(",").map((s) => s.trim());
const breakers = only
  ? BREAKERS.filter((b) => only.includes(b.name))
  : BREAKERS;
const RUNS = Number(process.env.RUNS ?? 1);
const MAX_WARM = Number(process.env.MAX_WARM ?? 3);
const DELAY_MS = Number(process.env.DELAY_MS ?? 3000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);

if (process.env.FRESH === "true" && fs.existsSync(OUT)) fs.rmSync(OUT);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const batch = new Date().toISOString();
const tasks = [];
for (let run = 0; run < RUNS; run++) {
  for (const breaker of breakers) {
    tasks.push(async () => {
      const seed = crypto.randomInt(1, 2 ** 31);
      const nonce = crypto.randomBytes(6).toString("hex");
      const t = await runBreaker({
        model: MODEL,
        breaker,
        seed,
        nonce,
        maxWarm: MAX_WARM,
        delayMs: DELAY_MS,
      });
      const row = {
        timestamp: new Date().toISOString(),
        batch,
        run,
        model: MODEL,
        variant: breaker.name,
        group: breaker.group,
        seed,
        nonce,
        warm_sends: t.warmSends,
        base_prompt: t.basePrompt,
        base_cached: t.baseCached,
        base_counted: t.baseCounted,
        prompt: t.prompt,
        cached: t.cached,
        counted: t.counted,
        error: t.error,
      };
      appendRows(OUT, COLUMNS, [row]);
      const inf = (p: number | null, c: number | null) =>
        p !== null && c !== null ? p - c : "?";
      console.log(
        `${breaker.name.padEnd(26)} base ${t.baseCached}/${t.basePrompt} (+${inf(t.basePrompt, t.baseCounted)}) → ${t.cached}/${t.prompt} (+${inf(t.prompt, t.counted)})${t.error ? ` ERR ${t.error.slice(0, 160)}` : ""}`
      );
    });
  }
}
console.log(`${tasks.length} trials, batch ${batch}`);
await pool(CONCURRENCY, tasks);
