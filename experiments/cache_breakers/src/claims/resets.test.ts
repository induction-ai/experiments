// Claims from blog.md § 2: request fields that reset the cache to zero.
// OpenAI Responses, gpt-5.6-sol.
import { describe, expect, it } from "@experiments/test";
import { expectZero, TIMEOUT, trial } from "./helpers.js";

describe("resets the cache to zero", () => {
  it.each([
    ["tool_add", "adding a tool"],
    ["tool_remove_last", "removing a tool"],
    ["tools_reorder", "reordering tools"],
    ["tools_remove_all", "removing all tools"],
    ["model_switch", "switching to the sibling model"],
    ["parallel_tool_calls_off", "parallel_tool_calls: false"],
    ["json_schema_format", "a text.format JSON schema"],
    ["verbosity_high", "text.verbosity: high"],
    ["cache_key_changed", "a different prompt_cache_key"],
    ["cache_key_removed", "omitting prompt_cache_key"],
    ["service_tier_flex", "service_tier: flex"],
    ["service_tier_priority", "service_tier: priority"],
  ])(
    "%s: %s reuses nothing",
    async (name) => {
      expectZero(await trial(name));
    },
    TIMEOUT
  );

  it(
    "parallel_tool_calls: false is rendered into the prompt (+~80 input tokens)",
    async () => {
      const row = await trial("parallel_tool_calls_off");
      expect(row.input! - row.base_input!).toBeGreaterThan(40);
    },
    TIMEOUT
  );
});

describe("rejected by gpt-5.6-sol", () => {
  it.each(["temperature", "top_p"])(
    "%s is an unsupported parameter",
    async (name) => {
      const row = await trial(name);
      expect(row.warmed).toBe(true);
      expect(row.error).toMatch(/Unsupported parameter/);
    },
    TIMEOUT
  );
});
