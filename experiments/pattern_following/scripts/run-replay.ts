/**
 * Question: when a context-management step replaces the arguments of an
 * agent's own past tool calls with `...`, does the agent start writing `...`
 * into its next tool call, and does that get likelier the more stubbed calls
 * its history holds?
 *
 * Per trial: take one real trajectory's final request from
 * data/trajectories/, cut it at a point where the agent's next move was a
 * batch of tool calls (up to MAX_TURNS such points per trajectory, evenly
 * spread), apply one condition to the history before the cut, send it once
 * and record what the agent does next.
 *
 * Conditions:
 *   intact     no edit (the control)
 *   stub_all   every past call's argument values replaced with `...`
 *   keep_3     the same, except the 3 most recent calls keep their arguments
 *   stub_last_3  only the 3 most recent calls stubbed; older calls intact
 *
 * Reading the result: a reply copies when any of its calls has a `...`
 * argument (`stubbed_calls` > 0). The thesis is supported if copying is near
 * zero for `intact` and rises with `stubbed_in_history` for the stubbed
 * conditions; `keep_3` shows whether a few intact recent calls prevent it.
 *
 * Appends RUNS trials per (trajectory, cut, condition) to
 * results/replay/banking.csv. With SUMMARIES=true, rows also store the
 * readable reasoning summary the API returned (often empty) and go to
 * results/replay/banking_summaries.csv instead.
 *
 * Env: TRAJECTORIES (comma-separated names; default every file in
 * data/trajectories/), CONDITIONS (default intact,stub_all,keep_3;
 * stub_last_3 runs only when listed),
 * MAX_TURNS (12), TURNS (comma-separated turn numbers to keep; default all),
 * RUNS (2), SUMMARIES (false), MODEL, EFFORT, CONCURRENCY and FRESH (see
 * src/trials.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countCalls,
  countStubbed,
  spreadEvenly,
  stubArguments,
  stubLastCalls,
  toolTurnCuts,
} from "../src/replay.js";
import type { InputItem } from "../src/responses.js";
import { runTrials, type CapturedRequest, type Trial } from "../src/trials.js";

const CONDITIONS = {
  intact: (history: InputItem[]) => history,
  stub_all: (history: InputItem[]) => stubArguments(history, 0),
  keep_3: (history: InputItem[]) => stubArguments(history, 3),
  stub_last_3: (history: InputItem[]) => stubLastCalls(history, 3),
} satisfies Record<string, (history: InputItem[]) => InputItem[]>;
type Condition = keyof typeof CONDITIONS;

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "../data/trajectories");
const names = process.env.TRAJECTORIES
  ? process.env.TRAJECTORIES.split(",")
  : fs
      .readdirSync(dataDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
const conditions = (process.env.CONDITIONS?.split(",") ?? [
  "intact",
  "stub_all",
  "keep_3",
]) as Condition[];
for (const c of conditions) {
  if (!(c in CONDITIONS)) throw new Error(`unknown condition: ${c}`);
}
const maxTurns = Number(process.env.MAX_TURNS ?? 12);
const runs = Number(process.env.RUNS ?? 2);
const turns = process.env.TURNS?.split(",").map(Number);
const summaries = process.env.SUMMARIES === "true";

const trials: Trial[] = names.flatMap((name) => {
  const captured = JSON.parse(
    fs.readFileSync(path.join(dataDir, `${name}.json`), "utf8")
  ) as CapturedRequest;
  const full = captured.input;
  return spreadEvenly(toolTurnCuts(full), maxTurns).flatMap((cut, turn) => {
    if (turns && !turns.includes(turn)) return [];
    const history = full.slice(0, cut);
    const originalNext = full
      .slice(cut)
      .filter((item) => item.type === "function_call")
      .slice(0, 1)
      .map((item) => item.name)
      .join("");
    return conditions.flatMap((condition) => {
      const input = CONDITIONS[condition](history);
      return Array.from({ length: runs }, (_, run) => ({
        label: `${name} turn ${turn} ${condition} run ${run}`,
        run,
        input,
        captured,
        fields: {
          trajectory: name,
          condition,
          turn,
          cut,
          calls_in_history: countCalls(history),
          stubbed_in_history: countStubbed(input),
          original_next: originalNext,
        },
      }));
    });
  });
});

await runTrials({
  captured: trials[0]!.captured!,
  csvPath: path.join(
    here,
    `../results/replay/${summaries ? "banking_summaries" : "banking"}.csv`
  ),
  columns: [
    "batch",
    "run",
    "trajectory",
    "condition",
    "turn",
    "cut",
    "calls_in_history",
    "stubbed_in_history",
    "original_next",
    "model",
    "effort",
    "history_items",
    "tool_calls",
    "stubbed_calls",
    "searches",
    "sent_message",
    "tool_names",
    "calls",
    "input_tokens",
    "cached_tokens",
    "output_tokens",
    "reasoning_tokens",
    "error",
    "timestamp",
    ...(summaries ? ["reasoning_summary"] : []),
  ],
  trials,
  summarize: (m) =>
    `${m.stubbed_calls}/${m.tool_calls} calls stubbed (${m.tool_names || "no calls"})`,
});
