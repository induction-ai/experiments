// Claims about single changes to a warm gemini-4-argon request
// (scripts/run-breakers.ts).
import { describe, expect, it } from "@experiments/test";
import { BREAKERS, runBreaker, type BreakerTrial } from "../breakers.js";
import { ARGON, DELAY, NOISE, TIMEOUT, untilPrecondition } from "./helpers.js";

const hidden = (p: number | null, c: number | null) => (p ?? 0) - (c ?? 0);
/** The base was cached, and argon's hidden block didn't switch on or off. */
const clean = (t: BreakerTrial) =>
  !t.error &&
  (t.baseCached ?? 0) > 0 &&
  Math.abs(hidden(t.prompt, t.counted) - hidden(t.basePrompt, t.baseCounted)) <
    300;

const trial = (name: string) => {
  const breaker = BREAKERS.find((b) => b.name === name);
  if (!breaker) throw new Error(`no breaker ${name}`);
  return untilPrecondition(
    `breaker:${name}`,
    3,
    (f) =>
      runBreaker({ model: ARGON, breaker, maxWarm: 3, delayMs: DELAY, ...f }),
    clean
  );
};

describe("argon cache breakers", () => {
  it.each([
    "control",
    "late_question_edit_end",
    "final_edit",
    "image_in_final",
    "system_as_two_parts",
    "tool_schema_key_order",
    "append_turn",
    "temperature",
    "top_p",
    "max_output_tokens",
    "stop_sequences",
    "seed",
    "include_thoughts",
    "safety_settings",
    "tool_mode_any",
  ])(
    "argon %s: keeps the whole cache",
    async (name) => {
      const t = await trial(name);
      expect(clean(t)).toBe(true);
      expect(t.cached).toBe(t.baseCached);
    },
    TIMEOUT
  );

  it.each([
    "system_edit_end",
    "early_edit_end",
    "tool_description_edit",
    "tool_add",
    "tools_reorder",
    "tools_remove_all",
    "thinking_high",
    "thinking_omitted",
    "tool_mode_none",
  ])(
    "argon %s: loses the whole cache",
    async (name) => {
      const t = await trial(name);
      expect(clean(t)).toBe(true);
      expect(t.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );

  it(
    "argon: JSON mode loses the cache that the same request without it keeps",
    async () => {
      const control = await trial("no_tools_control");
      expect(control.cached).toBeGreaterThan(NOISE);
      const t = await trial("json_mime_type");
      expect((t.baseCached ?? 0) > 0).toBe(true);
      expect(t.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );
});
