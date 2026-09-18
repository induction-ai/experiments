// Claims about Anthropic Messages with an explicit breakpoint at the end of
// the tools, the system prompt, the early exchange and the late exchange
// (claude-opus-5, ~600-word sections): the render order and which
// parameters invalidate which tier.
import { describe, expect, it } from "@experiments/test";
import { anthropicBreakpoints } from "../providers/anthropic-messages.js";
import {
  expectFallback,
  expectFull,
  expectZero,
  near,
  TIMEOUT,
  trial,
} from "./helpers.js";

const bp = (name: string) =>
  trial(name, { adapter: anthropicBreakpoints, sectionWords: 600 });

describe("anthropic explicit breakpoints", () => {
  it(
    "the cache is laid out tools → system → messages: each edit keeps exactly the sections before it",
    async () => {
      const tools = await bp("tools_edit_start");
      const system = await bp("system_edit_start");
      const early = await bp("early_edit_start");
      const late = await bp("late_edit_start");
      expectZero(tools);
      for (const r of [system, early, late]) expectFallback(r);
      expect(system.cached!).toBeLessThan(early.cached!);
      expect(early.cached!).toBeLessThan(late.cached!);
      expect(late.cached!).toBeLessThan(late.base_cached!);
    },
    TIMEOUT
  );

  it(
    "an edit at the end of a section falls back to the same breakpoint as one at its start",
    async () => {
      const start = await bp("system_edit_start");
      const end = await bp("system_edit_end");
      expectFallback(end);
      near(end.cached!, start.cached!, 40);
    },
    TIMEOUT
  );

  it(
    "tool_choice any or a named tool keeps tools + system and loses only the messages",
    async () => {
      const early = await bp("early_edit_start");
      for (const name of ["tool_choice_any", "tool_choice_tool"]) {
        const r = await bp(name);
        expectFallback(r);
        near(r.cached!, early.cached!, 60);
      }
    },
    TIMEOUT
  );

  it(
    "a JSON-schema output format keeps only the tools",
    async () => {
      const system = await bp("system_edit_start");
      const r = await bp("json_schema_format");
      expectFallback(r);
      near(r.cached!, system.cached!, 150);
    },
    TIMEOUT
  );

  it.each([
    ["model_switch", "switching model"],
    ["thinking_disabled", "turning thinking off"],
    ["inference_geo_us", "inference_geo: us"],
  ])(
    "%s: %s reuses nothing, even with a breakpoint on the tools",
    async (name) => {
      expectZero(await bp(name));
    },
    TIMEOUT
  );

  it.each([
    ["tool_choice_none", "tool_choice: none"],
    ["system_message_appended", "a mid-conversation system message"],
  ])(
    "%s: %s reuses everything",
    async (name) => {
      expectFull(await bp(name));
    },
    TIMEOUT
  );
});
