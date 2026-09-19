// Rows of the cross-API comparison: one per concept, mapped to each adapter's
// variant(s). Text states the change from the base request's value, so a
// reader can see what it was before. Several variants in one cell (e.g. two
// service tiers) are summarised together.

export interface Concept {
  /** Anchor id for the row's figure in the blog post. */
  id: string;
  group: string;
  text: string;
  /** Adapter name → variant names; an adapter left out has no such setting. */
  variants: Record<string, string[]>;
}

const OPENAI = ["openai_responses", "openai_responses_gpt-5.5"];
const ANTHROPIC = ["anthropic_auto", "anthropic_breakpoints"];

function both(openai: string[], anthropic: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (openai.length) for (const a of OPENAI) out[a] = openai;
  if (anthropic.length) for (const a of ANTHROPIC) out[a] = anthropic;
  return out;
}

/** The effort pairs are expanded per adapter from its variant list. */
export const EFFORT_PAIRS = "__effort_pairs__";

export const CONCEPTS: Concept[] = [
  {
    group: "control",
    id: "resend",
    text: "Resend the request unchanged",
    variants: both(["control"], ["control"]),
  },

  // Single-request edits: the history was never sent turn by turn.
  {
    group: "probe",
    id: "edit-tool-description",
    text: "Edit a tool description (first character, or one word appended)",
    variants: both(
      ["tools_edit_start", "tools_edit_end"],
      ["tools_edit_start", "tools_edit_end"]
    ),
  },
  {
    group: "probe",
    id: "edit-system-prompt-start",
    text: "Edit the system prompt: change its first character",
    variants: both(["system_edit_start"], ["system_edit_start"]),
  },
  {
    group: "probe",
    id: "edit-system-prompt-end",
    text: "Edit the system prompt: append one word to its end",
    variants: both(["system_edit_end"], ["system_edit_end"]),
  },
  {
    group: "probe",
    id: "edit-first-message-start",
    text: "Edit the first history message: change its first character",
    variants: both(["early_edit_start"], ["early_edit_start"]),
  },
  {
    group: "probe",
    id: "edit-first-message-end",
    text: "Edit the first history message: append one word to its end",
    variants: both(["early_edit_end"], ["early_edit_end"]),
  },
  {
    group: "probe",
    id: "edit-third-message-start",
    text: "Edit the third history message: change its first character",
    variants: both(["late_edit_start"], ["late_edit_start"]),
  },
  {
    group: "probe",
    id: "edit-third-message-end",
    text: "Edit the third history message: append one word to its end",
    variants: both(["late_edit_end"], ["late_edit_end"]),
  },
  {
    group: "probe",
    id: "edit-final-message",
    text: "Append one word to the final user message",
    variants: both(["final_edit"], ["final_edit"]),
  },
  {
    group: "probe",
    id: "edit-final-after-previous-turn",
    text: "Same, after the previous turn was sent once",
    variants: both(
      ["prev_turn_then_final_edit"],
      ["prev_turn_then_final_edit"]
    ),
  },
  {
    group: "probe",
    id: "edit-after-diverging-request",
    text: "Edit the third message after a request that diverged there was sent",
    variants: both(["sibling_then_late_edit"], ["sibling_then_late_edit"]),
  },
  {
    group: "messages",
    id: "append-turn",
    text: "Append a reply and a new user turn (normal conversation growth)",
    variants: both(["append_turn"], ["append_turn"]),
  },
  {
    group: "messages",
    id: "add-image",
    text: "Add a 1×1 image to the final user message",
    variants: both(["image_in_final"], ["image_in_final"]),
  },
  {
    group: "messages",
    id: "message-as-parts",
    text: "Send a message as text parts instead of a string (same text)",
    variants: both(["content_as_parts"], ["content_as_parts"]),
  },

  {
    group: "tools",
    id: "change-tool-list",
    text: "Add a tool, remove one, reorder them, or send none",
    variants: both(
      ["tool_add", "tool_remove_last", "tools_reorder", "tools_remove_all"],
      ["tool_add", "tool_remove_last", "tools_reorder", "tools_remove_all"]
    ),
  },
  {
    group: "tools",
    id: "toggle-strict",
    text: "Toggle `strict` on every tool (OpenAI true → false; Anthropic unset → true)",
    variants: both(["tool_strict_off"], ["tool_strict_on"]),
  },
  {
    group: "tools",
    id: "reorder-schema-keys",
    text: "Reorder JSON keys inside a tool’s schema (same meaning)",
    variants: both(["tool_schema_key_order"], ["tool_schema_key_order"]),
  },
  {
    group: "tools",
    id: "tool-choice-required",
    text: "`tool_choice`: auto (default) → must call a tool (`required` / `any`)",
    variants: both(["tool_choice_required"], ["tool_choice_any"]),
  },
  {
    group: "tools",
    id: "tool-choice-named",
    text: "`tool_choice`: auto (default) → a named tool",
    variants: both(["tool_choice_function"], ["tool_choice_tool"]),
  },
  {
    group: "tools",
    id: "tool-choice-none",
    text: "`tool_choice`: auto (default) → `none`",
    variants: both(["tool_choice_none"], ["tool_choice_none"]),
  },
  {
    group: "tools",
    id: "parallel-tool-calls-off",
    text: "Parallel tool calls: allowed (default) → off",
    variants: both(["parallel_tool_calls_off"], ["disable_parallel_tool_use"]),
  },

  {
    group: "system",
    id: "system-prompt-placement",
    text: "Where the system prompt lives: top-level field → a leading message (OpenAI) / string → text blocks (Anthropic)",
    variants: both(
      ["system_as_developer_message", "system_as_system_message"],
      ["system_as_blocks"]
    ),
  },
  {
    group: "system",
    id: "system-message-appended",
    text: "Append a system message mid-conversation (OpenAI `developer`; Anthropic `system`)",
    variants: both(["system_message_appended"], ["system_message_appended"]),
  },

  {
    group: "model",
    id: "switch-model",
    text: "Switch to the sibling model",
    variants: both(["model_switch"], ["model_switch"]),
  },

  {
    group: "reasoning",
    id: "change-effort",
    text: "Change reasoning effort, any level to any other",
    variants: both([EFFORT_PAIRS], [EFFORT_PAIRS]),
  },
  {
    group: "reasoning",
    id: "omit-default-effort",
    text: "Omit effort after warming at the default (medium on OpenAI, high on Anthropic)",
    variants: {
      openai_responses: ["effort_medium_omitted"],
      "openai_responses_gpt-5.5": ["effort_medium_omitted"],
      anthropic_auto: ["effort_high_omitted"],
      anthropic_breakpoints: ["effort_high_omitted"],
    },
  },
  {
    group: "reasoning",
    id: "effort-switch-back",
    text: "Change effort, then change it back (low → medium → low)",
    variants: both(["effort_switch_back"], ["effort_switch_back"]),
  },
  {
    group: "reasoning",
    id: "reasoning-summaries",
    text: "Ask for reasoning summaries (none, the default → summarized)",
    variants: both(["reasoning_summary"], ["thinking_display_summarized"]),
  },
  {
    group: "reasoning",
    id: "disable-thinking",
    text: "Thinking: adaptive (default) → disabled",
    variants: both([], ["thinking_disabled"]),
  },
  {
    group: "reasoning",
    id: "per-message-effort",
    text: "Per-message effort change (beta), or just its beta header",
    variants: both([], ["effort_per_message", "beta_header_only"]),
  },

  {
    group: "output",
    id: "max-output-tokens",
    text: "Max output tokens: 256 → 512",
    variants: both(["max_output_tokens"], ["max_tokens"]),
  },
  {
    group: "output",
    id: "json-schema-output",
    text: "Output format: plain text (default) → a JSON schema",
    variants: both(["json_schema_format"], ["json_schema_format"]),
  },
  {
    group: "output",
    id: "verbosity",
    text: "`text.verbosity`: medium (default) → high",
    variants: both(["verbosity_high"], []),
  },
  {
    group: "output",
    id: "stop-sequences",
    text: "Add stop sequences (none by default)",
    variants: both([], ["stop_sequences"]),
  },

  {
    group: "routing",
    id: "service-tier",
    text: "Service tier: default → another (OpenAI `priority` / `flex`; Anthropic `standard_only`)",
    variants: both(
      ["service_tier_priority", "service_tier_flex"],
      ["service_tier_standard_only"]
    ),
  },
  {
    group: "routing",
    id: "cache-retention",
    text: "Longer cache retention (OpenAI in-memory → 24h; Anthropic 5 min → 1 h)",
    variants: both(["cache_retention_24h"], ["cache_ttl_1h"]),
  },
  {
    group: "routing",
    id: "metadata",
    text: "Add request `metadata` (none by default)",
    variants: both(["metadata"], []),
  },
  {
    group: "routing",
    id: "end-user-id",
    text: "Add an end-user id (OpenAI `safety_identifier`; Anthropic `metadata.user_id`)",
    variants: both(["safety_identifier"], ["metadata_user_id"]),
  },
  {
    group: "routing",
    id: "cache-key",
    text: "`prompt_cache_key`: this trial’s key → a different key, or none",
    variants: both(["cache_key_changed", "cache_key_removed"], []),
  },
  {
    group: "routing",
    id: "store",
    text: "`store`: false → true",
    variants: both(["store_true"], []),
  },
  {
    group: "routing",
    id: "truncation",
    text: "`truncation`: disabled (default) → auto",
    variants: both(["truncation_auto"], []),
  },
  {
    group: "routing",
    id: "inference-geo",
    text: "`inference_geo`: default → us",
    variants: both([], ["inference_geo_us"]),
  },
  {
    group: "routing",
    id: "cache-mode-switch",
    text: "Automatic caching ↔ explicit breakpoints on the same content",
    variants: both([], ["cache_mode_switch"]),
  },
];
