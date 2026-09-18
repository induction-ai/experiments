// Claims from blog.md § 6: replaying a tool call with its reasoning item.
// OpenAI Responses, gpt-5.6-sol.
import { describe, expect, it } from "@experiments/test";
import {
  expectFallback,
  expectFull,
  expectZero,
  near,
  TIMEOUT,
  trial,
} from "./helpers.js";

const loop = (name: string) => trial(name, { scenario: "tool_loop" });

describe("tool loop", () => {
  it.each([
    ["control", "replaying the output items as returned"],
    ["strip_item_ids", "stripping the items' ids"],
    ["reasoning_by_reference", "the reasoning item as an item_reference"],
    ["output_items_by_reference", "both output items as item_references"],
    ["previous_response_id", "previous_response_id plus only the tool result"],
    ["then_user_turn", "a new user turn after the tool result"],
  ])(
    "%s: %s reuses everything",
    async (name) => {
      const row = await loop(name);
      expectFull(row);
    },
    TIMEOUT
  );

  it(
    "a new user turn doesn't strip earlier reasoning: input grows only by the new turn",
    async () => {
      const row = await loop("then_user_turn");
      expectFull(row);
      expect(row.input! - row.base_input!).toBeLessThan(80);
      expect(row.cache_write).toBe(row.input! - row.base_input!);
    },
    TIMEOUT
  );

  it(
    "dropping the reasoning item while the function_call keeps its id is rejected",
    async () => {
      const row = await loop("drop_reasoning");
      expect(row.warmed).toBe(true);
      expect(row.error).toMatch(/without its required 'reasoning' item/);
    },
    TIMEOUT
  );

  it(
    "dropping the reasoning item (ids stripped) falls back to the previous request's end",
    async () => {
      const edit = await loop("tool_output_edit");
      const drop = await loop("drop_reasoning_strip_ids");
      expectFallback(drop);
      // The rendered reasoning is gone from the prompt...
      expect(drop.input!).toBeLessThan(drop.base_input! - 50);
      // ...and reuse stops where the tool-result edit stops: just before it.
      near(drop.cached!, edit.cached!, 60);
    },
    TIMEOUT
  );

  it(
    "editing the tool result re-writes the unchanged reasoning and call too",
    async () => {
      const row = await loop("tool_output_edit");
      expectFallback(row);
      expect(row.cache_write!).toBeGreaterThan(300);
    },
    TIMEOUT
  );

  it(
    "changing reasoning effort mid-loop reuses nothing",
    async () => {
      expectZero(await loop("effort_medium"));
    },
    TIMEOUT
  );
});
