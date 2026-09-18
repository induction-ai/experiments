// Claims from blog.md § 2: changes that reuse the whole warm prompt.
// OpenAI Responses, gpt-5.6-sol.
import { describe, it } from "@experiments/test";
import { expectFull, TIMEOUT, trial } from "./helpers.js";

describe("no effect on the cache", () => {
  it.each([
    ["system_as_developer_message", "system prompt as a developer message"],
    ["system_as_system_message", "system prompt as a system message"],
    [
      "system_message_appended",
      "a developer message appended mid-conversation",
    ],
    ["tool_strict_off", "strict: false on every tool"],
    ["tool_schema_key_order", "reordered keys in a tool schema"],
    ["content_as_parts", "a message as input_text parts instead of a string"],
    ["max_output_tokens", "a different max_output_tokens"],
    ["reasoning_summary", "reasoning.summary: auto"],
    ["include_encrypted_reasoning", "include encrypted reasoning"],
    ["store_true", "store: true"],
    ["metadata", "metadata"],
    ["safety_identifier", "safety_identifier"],
    ["truncation_auto", "truncation: auto"],
    ["cache_retention_24h", "prompt_cache_retention: 24h"],
  ])(
    "%s: %s reuses everything",
    async (name) => {
      expectFull(await trial(name));
    },
    TIMEOUT
  );
});
