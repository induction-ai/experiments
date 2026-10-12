import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApiKey } from "@experiments/shared";
import { appendRows } from "./csv.js";
import { measureReply, type ReplyMeasures } from "./measure.js";
import {
  sendResponses,
  type InputItem,
  type ResponsesRequest,
} from "./responses.js";
import { searchPairs } from "./setups.js";

type Cell = string | number | boolean | null | undefined;

export type CapturedRequest = ResponsesRequest & {
  reasoning: { effort: string };
};

const dataDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../data"
);

export function loadCapturedRequest(conversation: string): CapturedRequest {
  return JSON.parse(
    fs.readFileSync(
      path.join(dataDir, conversation, "final_request.json"),
      "utf8"
    )
  ) as CapturedRequest;
}

export type Trial = {
  /** Shown in progress output, e.g. "snake_3 run 2". */
  label: string;
  run: number;
  input: InputItem[];
  /** Script-specific columns, e.g. the setup name. */
  fields: Record<string, Cell>;
  /** The request this trial's input came from, when it isn't `captured`. */
  captured?: CapturedRequest;
};

/**
 * Sends every trial once and appends one CSV row per reply. MODEL and EFFORT
 * default to the captured request's; CONCURRENCY defaults to 4; FRESH=true
 * wipes the CSV first.
 */
export async function runTrials(options: {
  captured: CapturedRequest;
  trials: Trial[];
  csvPath: string;
  columns: readonly string[];
  summarize: (measures: ReplyMeasures) => string;
}): Promise<void> {
  const { captured, trials, csvPath, columns, summarize } = options;
  const concurrency = Number(process.env.CONCURRENCY ?? 4);

  if (process.env.FRESH === "true") fs.rmSync(csvPath, { force: true });
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });

  const apiKey = getApiKey("openai");
  const batch = new Date().toISOString();

  async function runTrial(trial: Trial) {
    const request = trial.captured ?? captured;
    const model = process.env.MODEL ?? request.model;
    const effort = process.env.EFFORT ?? request.reasoning.effort;
    const base = {
      ...trial.fields,
      batch,
      run: trial.run,
      model,
      effort,
      history_items: trial.input.length,
      timestamp: new Date().toISOString(),
    };
    try {
      const response = await sendResponses(
        {
          ...request,
          model,
          reasoning: { ...request.reasoning, effort },
          input: trial.input,
        },
        apiKey
      );
      const usage = response.usage;
      const measures = measureReply(
        response,
        new Set(searchPairs(trial.input).map((pair) => pair.query))
      );
      return {
        row: {
          ...base,
          ...measures,
          input_tokens: usage?.input_tokens,
          cached_tokens: usage?.input_tokens_details?.cached_tokens,
          output_tokens: usage?.output_tokens,
          reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens,
        },
        summary: summarize(measures),
      };
    } catch (err) {
      return { row: { ...base, error: String(err) }, summary: String(err) };
    }
  }

  let next = 0;
  let done = 0;
  async function worker() {
    while (next < trials.length) {
      const trial = trials[next++]!;
      const { row, summary } = await runTrial(trial);
      appendRows(csvPath, columns, [row]);
      done++;
      console.log(`[${done}/${trials.length}] ${trial.label}: ${summary}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`wrote ${csvPath}`);
}
