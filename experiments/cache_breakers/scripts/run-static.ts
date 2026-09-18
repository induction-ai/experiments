/**
 * Question: which request parameters break a warm implicit prompt cache, and
 * in what order does the API lay out the cached prefix?
 *
 * Per trial: build a fresh seeded fixture (tools, system prompt, two history
 * exchanges, final user message; every section tagged with a fresh nonce so
 * trials never share a prefix). Send the base request until it reports cached
 * tokens (warm), then send it once more with exactly one change (the variant)
 * and record the usage.
 *
 * Reading the result: `cached` on the variant call is the prefix the cache
 * still matched. The `*_edit_start` probes give each section's start offset,
 * so their order is the render order. Any other variant is then placed by
 * where its cached count lands: `full` (no effect), a section name (the change
 * sits at that section's start), or `start` (nothing reused). A hypothesis
 * such as "tool_choice only breaks the messages" is confirmed if the variant's
 * cached count equals the offset of the first message.
 *
 * Appends RUNS trials per variant to results/static/<adapter>.csv. Run again
 * to add more trials; FRESH=true wipes that adapter's CSV first.
 *
 * The `prev_turn_*` and `sibling_*` probes also send one extra request after
 * warming (an earlier turn, or a diverging sibling) to test whether an edit
 * can fall back to that request's end instead of the header.
 *
 * Env: PROVIDER (openai_responses | anthropic_auto | anthropic_breakpoints),
 * MODEL (adapter default), RUNS (1),
 * VARIANTS (comma-separated names; default all), SECTION_WORDS (1500),
 * CONCURRENCY (4), DELAY_MS (1500), MAX_WARM (4), FRESH (false).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_COLUMNS, runFromEnv } from "../src/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));

await runFromEnv({
  scenario: "static",
  dir: path.join(here, "../results/static"),
  columns: BASE_COLUMNS,
});
