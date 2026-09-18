// Claims about Anthropic Messages with automatic caching (one top-level
// `cache_control`), claude-opus-5. Sections of ~600 words keep every
// checkpoint above Opus 5's 512-token minimum at lower cost.
import { describe, expect, it } from "@experiments/test";
import { anthropicAuto } from "../providers/anthropic-messages.js";
import {
  expectFallback,
  expectFull,
  expectZero,
  TIMEOUT,
  trial,
} from "./helpers.js";

const auto = (name: string) =>
  trial(name, { adapter: anthropicAuto, sectionWords: 600 });

describe("anthropic auto caching", () => {
  it(
    "control: resending the warm request unchanged reuses everything",
    async () => {
      expectFull(await auto("control"));
    },
    TIMEOUT
  );

  it.each([
    ["tools_edit_start", "the tools"],
    ["system_edit_end", "the system prompt"],
    ["early_edit_start", "the first history message"],
    ["late_edit_end", "the third history message"],
    ["final_edit", "the final user message"],
  ])(
    "%s: any edit, even to %s, reuses nothing",
    async (name) => {
      expectZero(await auto(name));
    },
    TIMEOUT
  );

  it(
    "after the previous turn has been sent, a final-message edit falls back to that turn's end",
    async () => {
      const row = await auto("prev_turn_then_final_edit");
      expectFallback(row);
      expect(row.cached! / row.base_cached!).toBeGreaterThan(0.7);
    },
    TIMEOUT
  );

  it(
    "a sibling request that diverges after the shared history gives no reuse",
    async () => {
      expectZero(await auto("sibling_then_late_edit"));
    },
    TIMEOUT
  );

  it(
    "appending a turn (normal conversation growth) reuses everything before it",
    async () => {
      expectFull(await auto("append_turn"));
    },
    TIMEOUT
  );

  it.each([
    ["tool_add", "adding a tool"],
    ["tool_remove_last", "removing a tool"],
    ["tools_reorder", "reordering tools"],
    ["model_switch", "switching to claude-sonnet-5"],
    ["tool_choice_any", "tool_choice: any"],
    ["tool_choice_tool", "forcing a named tool"],
    ["image_in_final", "an image in the final message"],
    ["json_schema_format", "an output_config.format JSON schema"],
    ["inference_geo_us", "inference_geo: us"],
    ["thinking_disabled", "turning thinking off"],
    ["beta_header_only", "the per-message-effort beta header alone"],
    ["effort_per_message", "a per-message effort change (beta)"],
  ])(
    "%s: %s reuses nothing",
    async (name) => {
      expectZero(await auto(name));
    },
    TIMEOUT
  );

  it.each([
    ["tool_choice_none", "tool_choice: none"],
    ["disable_parallel_tool_use", "disable_parallel_tool_use"],
    ["system_as_blocks", "system as text blocks instead of a string"],
    ["system_message_appended", "a mid-conversation system message"],
    ["tool_strict_on", "strict: true on every tool"],
    ["tool_schema_key_order", "reordered keys in a tool schema"],
    ["content_as_parts", "a message as text blocks instead of a string"],
    ["max_tokens", "a different max_tokens"],
    ["stop_sequences", "stop_sequences"],
    ["metadata_user_id", "metadata.user_id"],
    ["service_tier_standard_only", "service_tier: standard_only"],
    ["cache_ttl_1h", "a 1h TTL instead of 5 minutes"],
    ["cache_mode_switch", "an explicit breakpoint in place of automatic"],
    ["thinking_adaptive_explicit", "thinking: adaptive sent explicitly"],
    ["thinking_display_summarized", "thinking display: summarized"],
  ])(
    "%s: %s reuses everything",
    async (name) => {
      expectFull(await auto(name));
    },
    TIMEOUT
  );

  it.each(["temperature", "top_p"])(
    "%s is rejected as deprecated on claude-opus-5",
    async (name) => {
      const row = await auto(name);
      expect(row.warmed).toBe(true);
      expect(row.error).toMatch(/deprecated/);
    },
    TIMEOUT
  );
});
