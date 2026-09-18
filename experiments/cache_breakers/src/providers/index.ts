import { anthropicAuto, anthropicBreakpoints } from "./anthropic-messages.js";
import { openaiResponses, openaiResponses55 } from "./openai-responses.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<string, Adapter> = {
  openai_responses: openaiResponses,
  "openai_responses_gpt-5.5": openaiResponses55,
  anthropic_auto: anthropicAuto,
  anthropic_breakpoints: anthropicBreakpoints,
};
