/**
 * Question: in a tool-calling loop, which ways of replaying the model's own
 * output (reasoning items / signatures, the tool call, the tool result) keep
 * the implicit cache warm, and which break it?
 *
 * Per trial: build a fresh seeded fixture, then make one live call whose final
 * message asks for a tool call (reasoning.encrypted_content included). The
 * base request is what a client sends next: the original input, the returned
 * output items verbatim, and a synthetic tool result. Warm that base until it
 * reports cached tokens, then send it once more with one change (the variant)
 * and record usage.
 *
 * Reading the result: `control` should keep everything. If a variant that
 * drops or references the reasoning item keeps the full prefix, the reasoning
 * item isn't part of the cached prompt at that point; if it falls back to the
 * header, it is. `then_user_turn` tests whether starting a new user turn
 * strips earlier reasoning (which would show as a cache break at the reasoning
 * item even though the client re-sent it byte for byte).
 *
 * Appends RUNS trials per variant to results/tool_loop/<adapter>.csv. Run
 * again to add more trials; FRESH=true wipes that adapter's CSV first.
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
  scenario: "tool_loop",
  dir: path.join(here, "../results/tool_loop"),
  columns: BASE_COLUMNS,
});
