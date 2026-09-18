// Claims about replaying a tool call with its thinking block on Anthropic
// Messages (claude-opus-5, automatic caching, ~600-word sections).
import { describe, expect, it } from "@experiments/test";
import { anthropicAuto } from "../providers/anthropic-messages.js";
import {
  expectFallback,
  expectFull,
  expectZero,
  TIMEOUT,
  trial,
} from "./helpers.js";

const loop = (name: string) =>
  trial(name, {
    adapter: anthropicAuto,
    scenario: "tool_loop",
    sectionWords: 600,
  });

describe("anthropic tool loop", () => {
  it(
    "replaying the assistant turn verbatim reuses everything",
    async () => {
      expectFull(await loop("control"));
    },
    TIMEOUT
  );

  it(
    "a new user turn after the tool result reuses everything (thinking isn't stripped)",
    async () => {
      expectFull(await loop("then_user_turn"));
    },
    TIMEOUT
  );

  it.each([
    ["drop_thinking", "dropping the thinking block is accepted and"],
    ["tool_result_edit", "editing the tool result"],
  ])(
    "%s: %s falls back to exactly the previous request's end",
    async (name) => {
      const row = await loop(name);
      expectFallback(row);
      // The base's first call read the seed request's checkpoint, which is
      // the previous request's end; the variant lands on the same point.
      expect(Math.abs(row.cached! - row.first_cached!)).toBeLessThanOrEqual(8);
    },
    TIMEOUT
  );

  it(
    "an edited thinking signature is rejected",
    async () => {
      const row = await loop("thinking_signature_edit");
      expect(row.warmed).toBe(true);
      expect(row.error).toMatch(/Invalid `signature`/);
    },
    TIMEOUT
  );

  it(
    "changing effort mid-loop reuses nothing",
    async () => {
      expectZero(await loop("effort_medium"));
    },
    TIMEOUT
  );
});
