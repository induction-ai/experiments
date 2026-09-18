/**
 * Question: is gpt-5.6-sol's message-level cache matching specific to that
 * model, or do older OpenAI models match a longer prefix in 128-token
 * blocks, as OpenAI's caching docs describe?
 *
 * Per trial: the static procedure (fresh fixture, warm the base, send one
 * variant) with a probe that edits the end of one long block:
 *   system_edit_end  128-token blocks keep ~all of tools + instructions;
 *                    message-level matching keeps 0.
 *   early_edit_end   blocks keep into the first history message;
 *                    message-level keeps only the tools+instructions header.
 *   final_edit       blocks keep nearly everything, rounded down to 128;
 *                    message-level keeps only the header.
 * plus control. A cached count that is a multiple of 128 inside the edited
 * block confirms block matching for that model.
 *
 * Appends RUNS trials per model and probe to results/models/openai_responses.csv.
 *
 * Env: MODELS (gpt-4o,gpt-4.1,gpt-5,gpt-5.4,gpt-5.5), VARIANTS (the four
 * above), RUNS (2), plus the static script's knobs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_COLUMNS, runFromEnv } from "../src/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const models = (
  process.env.MODELS ?? "gpt-4o,gpt-4.1,gpt-5,gpt-5.4,gpt-5.5"
).split(",");
process.env.VARIANTS ??= "control,system_edit_end,early_edit_end,final_edit";
process.env.RUNS ??= "2";

for (const model of models) {
  process.env.MODEL = model;
  await runFromEnv({
    scenario: "static",
    dir: path.join(here, "../results/models"),
    columns: BASE_COLUMNS,
  });
}
