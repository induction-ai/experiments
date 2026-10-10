/**
 * Question: how many earlier searches in one query style does it take before
 * the agent's next search query is in that style too?
 *
 * Per trial: take a captured conversation's final request (default
 * banking_021), cut it right before the agent's last batch of searches, and
 * rewrite every earlier search query in STYLE. Then append N more searches
 * (one trial per N in COUNTS) that repeat the real searches in turn: each
 * has the real query in STYLE and the real search's result. Send it once and record what the agent does next.
 *
 * Styles:
 *   dots   every query is `...`
 *   snake  every query in snake_case (`cash_back_rewards_policy`)
 *
 * With SOURCE=new (snake only), the added searches don't repeat anything:
 * they are the first N pairs of data/kb_search_pool.json, real searches and
 * results from other conversations with the same knowledge base, so a copy
 * has to be a new query written in the style. Replayed queries are counted
 * separately.
 *
 * With SOURCE=failed, the added searches repeat the real ones as usual, but
 * each comes back with "No results found." (the real searches keep their
 * results), so the history shows the styled query failing.
 *
 * Reading the result: a reply copies when it sends a search whose query is in
 * STYLE (exactly `...`, or fully snake_case). Copying is supported if the
 * share of replies that copy rises with the number of styled searches in the
 * history.
 *
 * Start with the doubling sweep (the default COUNTS), then narrow down by
 * re-running with counts between the two where copying turns on.
 *
 * With INSTRUCTION set, that text is appended on its own line to the end of
 * the system prompt, and rows go to a directory with an `_instructed` suffix
 * (e.g. results/dots_instructed/) with the text in an `instruction` column.
 *
 * With SUMMARIES=true, each row also stores the reasoning summary text the
 * API returned (often empty), in a directory with a `_summaries` suffix.
 *
 * Appends RUNS trials per count to results/<STYLE>/<CONVERSATION>.csv, or
 * results/<STYLE>_new/<CONVERSATION>.csv with SOURCE=new, or
 * results/<STYLE>_failed/<CONVERSATION>.csv with SOURCE=failed.
 *
 * Env: STYLE (dots | snake; default dots), SOURCE (repeat | new | failed;
 * default repeat), COUNTS (comma-separated; default
 * 0,4,8,16,32,64), RUNS (5), CONVERSATION (banking_021), MODEL, EFFORT,
 * CONCURRENCY and FRESH (see src/trials.ts), INSTRUCTION (none), SUMMARIES
 * (false).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  historyBeforeLastSearch,
  QUERY_STYLES,
  restyleWithAddedSearches,
  restyleWithFailedSearches,
  restyleWithNewSearches,
  withSystemNote,
  type QueryStyle,
  type SearchPair,
} from "../src/setups.js";
import { loadCapturedRequest, runTrials } from "../src/trials.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const style = (process.env.STYLE ?? "dots") as QueryStyle;
if (!(style in QUERY_STYLES)) throw new Error(`unknown style: ${style}`);
const conversation = process.env.CONVERSATION ?? "banking_021";
const runs = Number(process.env.RUNS ?? 5);
const counts = (process.env.COUNTS ?? "0,4,8,16,32,64").split(",").map(Number);
const source = process.env.SOURCE ?? "repeat";
if (source !== "repeat" && source !== "new" && source !== "failed") {
  throw new Error(`unknown source: ${source}`);
}
if (source === "new" && style !== "snake") {
  throw new Error("SOURCE=new needs STYLE=snake");
}
const instruction = process.env.INSTRUCTION;
const summaries = process.env.SUMMARIES === "true";
const csvDir =
  (source === "repeat" ? style : `${style}_${source}`) +
  (instruction ? "_instructed" : "") +
  (summaries ? "_summaries" : "");
const pool = JSON.parse(
  fs.readFileSync(path.join(here, "../data/kb_search_pool.json"), "utf8")
) as SearchPair[];

const captured = loadCapturedRequest(conversation);
const history = historyBeforeLastSearch(captured.input);
const realSearches = history.filter(
  (item) => item.type === "function_call" && item.name === "KB_search"
).length;

function buildInput(added: number) {
  const input =
    source === "new"
      ? restyleWithNewSearches(history, style, added, pool)
      : source === "failed"
        ? restyleWithFailedSearches(history, style, added)
        : restyleWithAddedSearches(history, style, added);
  return instruction ? withSystemNote(input, instruction) : input;
}

await runTrials({
  captured,
  csvPath: path.join(here, `../results/${csvDir}/${conversation}.csv`),
  columns: [
    "batch",
    "run",
    "added",
    `${style}_in_history`,
    "model",
    "effort",
    "history_items",
    "tool_calls",
    "searches",
    `${style}_queries`,
    "sent_message",
    "tool_names",
    "queries",
    "input_tokens",
    "cached_tokens",
    "output_tokens",
    "reasoning_tokens",
    "error",
    "timestamp",
    ...(source === "new" ? ["new_snake_queries", "replayed_queries"] : []),
    ...(instruction ? ["instruction"] : []),
    ...(summaries ? ["reasoning_summary"] : []),
  ],
  trials: counts.flatMap((added) =>
    Array.from({ length: runs }, (_, run) => ({
      label: `${added} added, run ${run}`,
      run,
      input: buildInput(added),
      fields: {
        added,
        [`${style}_in_history`]: realSearches + added,
        instruction,
      },
    }))
  ),
  summarize: (m) =>
    source === "new"
      ? `${m.new_snake_queries}/${m.searches} new snake_case, ${m.replayed_queries} replayed (${m.tool_calls} calls)`
      : `${m[`${style}_queries`]}/${m.searches} queries in ${style} style (${m.tool_calls} calls)`,
});
