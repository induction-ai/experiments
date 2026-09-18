// Claims from blog.md § 4: tool_choice swaps a fixed tail at the end of the
// prompt. It invalidates nothing and writes nothing.
// OpenAI Responses, gpt-5.6-sol.
import { describe, expect, it } from "@experiments/test";
import { expectClean, TIMEOUT, trial } from "./helpers.js";

describe("tool_choice", () => {
  it.each([
    ["tool_choice_none", 72],
    ["tool_choice_required", 119],
    ["tool_choice_function", 129],
  ])(
    "%s leaves input unchanged, writes nothing, and bills ~%i tokens uncached",
    async (name, tail) => {
      const row = await trial(name);
      expectClean(row);
      expect(row.input).toBe(row.base_input);
      expect(row.cache_write).toBe(0);
      const lost = row.base_cached! - row.cached!;
      expect(Math.abs(lost - tail)).toBeLessThanOrEqual(2);
    },
    TIMEOUT
  );
});
