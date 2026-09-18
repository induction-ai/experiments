import { getApiKey } from "@experiments/shared";
import {
  editAt,
  editEnd,
  editStart,
  mulberry32,
  words,
  type Fixture,
  type ToolDef,
  type Turn,
} from "../fixture.js";
import type {
  Adapter,
  CallResult,
  Json,
  ToolLoop,
  Usage,
  Variant,
} from "./types.js";

const URL = "https://api.openai.com/v1/responses";

// A 1x1 PNG, for the "image in the last message" variant.
const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tool(t: ToolDef): Json {
  return {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: true,
  };
}

function message(t: Turn): Json {
  return { role: t.role, content: t.text };
}

type Body = Json & {
  tools: Json[];
  input: Json[];
  instructions?: string;
};

// input layout: [early user, early assistant, late user, late assistant, final user]
const EARLY = 0;
const LATE = 2;
const FINAL = 4;

function editMessage(
  body: Json,
  index: number,
  edit: (s: string) => string
): Json {
  const b = body as Body;
  const msg = b.input[index]!;
  msg.content = edit(msg.content as string);
  return b;
}

export function renderResponses(fixture: Fixture, model: string): Json {
  return {
    model,
    instructions: fixture.system,
    tools: fixture.tools.map(tool),
    input: [...fixture.early, ...fixture.late].map(message).concat({
      role: "user",
      content: fixture.final,
    }),
    // Non-reasoning models (gpt-4o, gpt-4.1) reject the reasoning field.
    ...(/^(gpt-5|o\d)/.test(model) ? { reasoning: { effort: "low" } } : {}),
    max_output_tokens: 256,
    store: false,
    // Pins routing to one cache shard per trial; see the prompt_cache_key variants.
    prompt_cache_key: fixture.nonce,
  };
}

export function parseResponsesUsage(body: Json): Usage | null {
  const u = body.usage as
    | {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        output_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
  if (!u) return null;
  return {
    input: u.input_tokens,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u.input_tokens_details?.cache_write_tokens ?? null,
    output: u.output_tokens,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
  };
}

async function send(body: Json): Promise<CallResult> {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${getApiKey("openai")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Json;
  const err = json.error as { message?: string } | null | undefined;
  return {
    status: res.status,
    usage: res.ok ? parseResponsesUsage(json) : null,
    error: res.ok ? null : (err?.message ?? `HTTP ${res.status}`),
    body: json,
  };
}

const set =
  (patch: Json) =>
  (b: Json): Json => ({ ...b, ...patch });

export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

const withEffort = (effort: string) => (b: Json) => ({
  ...b,
  reasoning: { effort },
});

/**
 * Every ordered pair of reasoning efforts, warmed at `from` and sent at `to`.
 * low→medium and low→none already exist as `effort_medium` / `effort_none`.
 */
function effortVariants(): Variant[] {
  const out: Variant[] = [];
  for (const from of EFFORTS) {
    for (const to of EFFORTS) {
      if (from === to) continue;
      if (from === "low" && (to === "medium" || to === "none")) continue;
      out.push({
        name: `effort_${from}_to_${to}`,
        group: "reasoning",
        description: `\`reasoning.effort\` ${from} → ${to}.`,
        rebase: withEffort(from),
        apply: withEffort(to),
      });
    }
    out.push({
      name: `effort_${from}_omitted`,
      group: "reasoning",
      description: `Warm at \`reasoning.effort: ${from}\`, then omit \`reasoning\` entirely.`,
      rebase: withEffort(from),
      apply: (b) => {
        delete b.reasoning;
        return b;
      },
    });
  }
  out.push({
    name: "effort_switch_back",
    group: "reasoning",
    description: "Warm at low, send one request at medium, then return to low.",
    prewarm: (b) => [withEffort("medium")(b)],
    apply: (b) => b,
  });
  return out;
}

/**
 * Replace one word at 8 evenly spaced points inside `instructions` and inside
 * the first history message. Plotting cached tokens against the edit's
 * position shows the matching granularity: a staircase for fixed-size
 * blocks, a flat line for message-level matching.
 */
export const SWEEP = [0.05, 0.175, 0.3, 0.425, 0.55, 0.675, 0.8, 0.925];
function sweepVariants(): Variant[] {
  return SWEEP.flatMap((f) => {
    const pct = Math.round(f * 1000) / 10;
    return [
      {
        name: `sweep_system_${pct}`,
        group: "sweep" as const,
        description: `Replace the word ${pct}% of the way through \`instructions\`.`,
        apply: (b: Json) => {
          const body = b as Body;
          body.instructions = editAt(body.instructions!, f);
          return body;
        },
      },
      {
        name: `sweep_early_${pct}`,
        group: "sweep" as const,
        description: `Replace the word ${pct}% of the way through the first history message.`,
        apply: (b: Json) => editMessage(b, EARLY, (x) => editAt(x, f)),
      },
    ];
  });
}

export const responsesVariants: Variant[] = [
  {
    name: "control",
    group: "control",
    description: "Resend the base request unchanged.",
    apply: (b) => b,
  },

  // Probes: edit one section, at its start or its end. The cached count after
  // each tells us where that section sits in the cached prefix.
  {
    name: "tools_edit_start",
    group: "probe",
    description:
      "Edit the tools: change the first character of the first tool description.",
    apply: (b) => {
      const t = (b as Body).tools[0]!;
      t.description = editStart(t.description as string);
      return b;
    },
  },
  {
    name: "tools_edit_end",
    group: "probe",
    description: "Edit the tools: append a word to the last tool description.",
    apply: (b) => {
      const tools = (b as Body).tools;
      const t = tools[tools.length - 1]!;
      t.description = editEnd(t.description as string);
      return b;
    },
  },
  {
    name: "system_edit_start",
    group: "probe",
    description:
      "Edit the system prompt: change the first character of `instructions`.",
    apply: (b) => {
      const body = b as Body;
      body.instructions = editStart(body.instructions!);
      return body;
    },
  },
  {
    name: "system_edit_end",
    group: "probe",
    description: "Edit the system prompt: append a word to `instructions`.",
    apply: (b) => {
      const body = b as Body;
      body.instructions = editEnd(body.instructions!);
      return body;
    },
  },
  {
    name: "early_edit_start",
    group: "probe",
    description:
      "Edit the history: change the first character of the first message.",
    apply: (b) => editMessage(b, EARLY, editStart),
  },
  {
    name: "early_edit_end",
    group: "probe",
    description: "Edit the history: append a word to the first message.",
    apply: (b) => editMessage(b, EARLY, editEnd),
  },
  {
    name: "late_edit_start",
    group: "probe",
    description:
      "Edit the history: change the first character of the third message.",
    apply: (b) => editMessage(b, LATE, editStart),
  },
  {
    name: "late_edit_end",
    group: "probe",
    description: "Edit the history: append a word to the third message.",
    apply: (b) => editMessage(b, LATE, editEnd),
  },
  {
    name: "final_edit",
    group: "probe",
    description: "Edit the final user message: append a word.",
    apply: (b) => editMessage(b, FINAL, editEnd),
  },

  // Does an edit fall back to an earlier request's end, or only to the header?
  {
    name: "prev_turn_then_final_edit",
    group: "probe",
    description:
      "Also send the previous turn (input up to the late user message), then edit the final message.",
    prewarm: (b) => [{ ...b, input: (b as Body).input.slice(0, LATE + 1) }],
    apply: (b) => editMessage(b, FINAL, editEnd),
  },
  {
    name: "prev_turn_then_late_reply_edit",
    group: "probe",
    description:
      "Also send the previous turn, then edit the assistant reply that followed it.",
    prewarm: (b) => [{ ...b, input: (b as Body).input.slice(0, LATE + 1) }],
    apply: (b) => editMessage(b, LATE + 1, editEnd),
  },
  {
    name: "sibling_then_late_edit",
    group: "probe",
    description:
      "Also send a request that shares the early exchange but diverges after it, then edit the late user message.",
    prewarm: (b, { fixture }) => [
      {
        ...b,
        input: [
          ...(b as Body).input.slice(0, LATE),
          { role: "user", content: `${fixture.extraTurn}. Reply with ok.` },
        ],
      },
    ],
    apply: (b) => editMessage(b, LATE, editEnd),
  },

  ...sweepVariants(),

  // Tools
  {
    name: "tool_add",
    group: "tools",
    description: "Append one more tool definition.",
    apply: (b, { fixture }) => {
      (b as Body).tools.push(tool(fixture.extraTool));
      return b;
    },
  },
  {
    name: "tool_remove_last",
    group: "tools",
    description: "Drop the last tool definition.",
    apply: (b) => {
      (b as Body).tools.pop();
      return b;
    },
  },
  {
    name: "tools_reorder",
    group: "tools",
    description: "Swap the last two tool definitions.",
    apply: (b) => {
      const t = (b as Body).tools;
      const n = t.length;
      [t[n - 2], t[n - 1]] = [t[n - 1]!, t[n - 2]!];
      return b;
    },
  },
  {
    name: "tools_remove_all",
    group: "tools",
    description: "Send no tools.",
    apply: (b) => {
      delete b.tools;
      return b;
    },
  },
  {
    name: "tool_strict_off",
    group: "tools",
    description: "`strict` on every tool: true → false.",
    apply: (b) => {
      for (const t of (b as Body).tools) t.strict = false;
      return b;
    },
  },
  {
    name: "tool_schema_key_order",
    group: "tools",
    description:
      "Reorder JSON keys inside the last tool's parameter schema (same meaning).",
    apply: (b) => {
      const tools = (b as Body).tools;
      const t = tools[tools.length - 1]!;
      const p = t.parameters as Json;
      t.parameters = {
        additionalProperties: p.additionalProperties,
        required: p.required,
        properties: p.properties,
        type: p.type,
      };
      return b;
    },
  },
  {
    name: "tool_choice_required",
    group: "tools",
    description: "`tool_choice`: auto (default) → `required`.",
    apply: set({ tool_choice: "required" }),
  },
  {
    name: "tool_choice_none",
    group: "tools",
    description: "`tool_choice`: auto (default) → `none`.",
    apply: set({ tool_choice: "none" }),
  },
  {
    name: "tool_choice_function",
    group: "tools",
    description: "`tool_choice`: auto (default) → the first tool by name.",
    apply: (b) => ({
      ...b,
      tool_choice: {
        type: "function",
        name: (b as Body).tools[0]!.name,
      },
    }),
  },
  {
    name: "parallel_tool_calls_off",
    group: "tools",
    description: "`parallel_tool_calls`: true (default) → false.",
    apply: set({ parallel_tool_calls: false }),
  },

  // System prompt placement
  {
    name: "system_as_developer_message",
    group: "system",
    description:
      "Move `instructions` into a leading `developer` message in `input`.",
    apply: (b) => {
      const body = b as Body;
      body.input.unshift({ role: "developer", content: body.instructions });
      delete body.instructions;
      return body;
    },
  },
  {
    name: "system_as_system_message",
    group: "system",
    description:
      "Move `instructions` into a leading `system` message in `input`.",
    apply: (b) => {
      const body = b as Body;
      body.input.unshift({ role: "system", content: body.instructions });
      delete body.instructions;
      return body;
    },
  },

  {
    name: "system_message_appended",
    group: "system",
    description:
      "Append a mid-conversation `developer` message after the final user message.",
    apply: (b) => {
      (b as Body).input.push({
        role: "developer",
        content: "Keep replies under ten words.",
      });
      return b;
    },
  },

  // Messages
  {
    name: "append_turn",
    group: "messages",
    description:
      "Append an assistant reply and a new user turn (normal conversation growth).",
    apply: (b, { fixture }) => {
      (b as Body).input.push(
        { role: "assistant", content: "ok" },
        { role: "user", content: `${fixture.extraTurn}. Reply with ok.` }
      );
      return b;
    },
  },
  {
    name: "image_in_final",
    group: "messages",
    description: "Add a 1x1 image to the final user message.",
    apply: (b) => {
      const body = b as Body;
      const msg = body.input[FINAL]!;
      msg.content = [
        { type: "input_text", text: msg.content },
        { type: "input_image", image_url: PIXEL_PNG },
      ];
      return body;
    },
  },
  {
    name: "content_as_parts",
    group: "messages",
    description:
      "Send the first history message as `[{type: input_text}]` instead of a string (same text).",
    apply: (b) => {
      const body = b as Body;
      const msg = body.input[EARLY]!;
      msg.content = [{ type: "input_text", text: msg.content }];
      return body;
    },
  },

  // Model
  {
    name: "model_switch",
    group: "model",
    description: "Switch to the sibling model.",
    apply: (b, { altModel }) => ({ ...b, model: altModel }),
  },

  // Reasoning
  {
    name: "effort_medium",
    group: "reasoning",
    description: "`reasoning.effort`: low → medium.",
    apply: set({ reasoning: { effort: "medium" } }),
  },
  {
    name: "effort_none",
    group: "reasoning",
    description: "`reasoning.effort`: low → none.",
    apply: set({ reasoning: { effort: "none" } }),
  },
  ...effortVariants(),
  {
    name: "reasoning_summary",
    group: "reasoning",
    description: "`reasoning.summary`: none (default) → auto.",
    apply: set({ reasoning: { effort: "low", summary: "auto" } }),
  },
  {
    name: "include_encrypted_reasoning",
    group: "reasoning",
    description:
      '`include`: none (default) → `["reasoning.encrypted_content"]`.',
    apply: set({ include: ["reasoning.encrypted_content"] }),
  },

  // Output shape
  {
    name: "max_output_tokens",
    group: "output",
    description: "`max_output_tokens`: 256 → 512.",
    apply: set({ max_output_tokens: 512 }),
  },
  {
    name: "json_schema_format",
    group: "output",
    description: "`text.format`: plain text (default) → a JSON schema.",
    apply: set({
      text: {
        format: {
          type: "json_schema",
          name: "reply",
          strict: true,
          schema: {
            type: "object",
            properties: { reply: { type: "string" } },
            required: ["reply"],
            additionalProperties: false,
          },
        },
      },
    }),
  },
  {
    name: "verbosity_high",
    group: "output",
    description: "`text.verbosity`: medium (default) → high.",
    apply: set({ text: { verbosity: "high" } }),
  },

  // Sampling
  {
    name: "temperature",
    group: "sampling",
    description: "`temperature`: unset → 0.5.",
    apply: set({ temperature: 0.5 }),
  },
  {
    name: "top_p",
    group: "sampling",
    description: "`top_p`: unset → 0.5.",
    apply: set({ top_p: 0.5 }),
  },

  // Routing and account-level knobs
  {
    name: "cache_key_changed",
    group: "routing",
    description: "`prompt_cache_key`: this trial’s key → a different one.",
    apply: (b, { fixture }) => ({
      ...b,
      prompt_cache_key: `${fixture.nonce}-other`,
    }),
  },
  {
    name: "cache_key_removed",
    group: "routing",
    description: "`prompt_cache_key`: this trial’s key → omitted.",
    apply: (b) => {
      delete b.prompt_cache_key;
      return b;
    },
  },
  {
    name: "cache_retention_24h",
    group: "routing",
    description: '`prompt_cache_retention`: in-memory (default) → `"24h"`.',
    apply: set({ prompt_cache_retention: "24h" }),
  },
  {
    name: "safety_identifier",
    group: "routing",
    description: "`safety_identifier`: unset → a synthetic id.",
    apply: set({ safety_identifier: "synthetic-user-1" }),
  },
  {
    name: "metadata",
    group: "routing",
    description: "`metadata`: none → one key.",
    apply: set({ metadata: { run: "cache-breakers" } }),
  },
  {
    name: "store_true",
    group: "routing",
    description: "`store`: false → true.",
    apply: set({ store: true }),
  },
  {
    name: "service_tier_flex",
    group: "routing",
    description: '`service_tier`: default → `"flex"`.',
    apply: set({ service_tier: "flex" }),
  },
  {
    name: "service_tier_priority",
    group: "routing",
    description: '`service_tier`: default → `"priority"`.',
    apply: set({ service_tier: "priority" }),
  },
  {
    name: "truncation_auto",
    group: "routing",
    description: '`truncation`: disabled (default) → `"auto"`.',
    apply: set({ truncation: "auto" }),
  },
];

// Tool loop: a live first call makes the model call a tool; the base request
// replays its output items (reasoning with encrypted_content, function_call)
// followed by the tool result, which is how a client continues the loop.

const isType = (t: string) => (item: Json) => item.type === t;

/** Remove server-assigned `id`s from replayed output items. */
function stripIds(input: Json[]): Json[] {
  return input.map((i) => {
    if (i.type !== "reasoning" && i.type !== "function_call") return i;
    const { id: _id, ...rest } = i;
    return rest;
  });
}

export async function buildToolLoopBase(
  fixture: Fixture,
  model: string
): Promise<{ base: Json; seed: Json } | { error: string }> {
  const first = renderResponses(fixture, model) as Body;
  const tool = fixture.tools[0]!;
  // A task that needs a little thought, so the output carries a reasoning
  // item; a bare "call tool X" gets 0 reasoning tokens and no reasoning item.
  first.input[FINAL] = {
    role: "user",
    content: `Work out 4817 * 293 and the number of letters in the longest word of the first message. Call ${tool.name} with query set to the product and region set to that letter count. After the result, reply with ok.`,
  };
  const seedReq = {
    ...first,
    // Forced so every trial gets a function_call; the base doesn't send it.
    tool_choice: "required",
    // Reasoning alone can use ~250 tokens, which truncates at the base's 256.
    max_output_tokens: 4096,
    include: ["reasoning.encrypted_content"],
    // Stored so item references and previous_response_id can point at it.
    store: true,
  };
  const res = await send(seedReq);
  if (res.error || !res.body) return { error: res.error ?? "no body" };
  if (res.body.status !== "completed") {
    return { error: `seed status ${String(res.body.status)}` };
  }
  const output = (res.body.output ?? []) as Json[];
  const call = output.find(isType("function_call"));
  if (!call) return { error: "no function_call in output" };
  if (!output.some(isType("reasoning"))) {
    return { error: "no reasoning item in output" };
  }
  const result = words(mulberry32(fixture.nonce.length + 7), 200);
  const base: Json = {
    ...first,
    input: [
      ...first.input,
      ...output,
      { type: "function_call_output", call_id: call.call_id, output: result },
    ],
    include: ["reasoning.encrypted_content"],
  };
  return { base, seed: res.body };
}

const toolLoopVariants: Variant[] = [
  {
    name: "control",
    group: "control",
    description: "Resend the tool-loop base unchanged.",
    apply: (b) => b,
  },
  {
    name: "drop_reasoning",
    group: "loop",
    description: "Remove the reasoning item before the function_call.",
    apply: (b) => ({
      ...b,
      input: (b as Body).input.filter((i) => i.type !== "reasoning"),
    }),
  },
  {
    name: "drop_reasoning_strip_ids",
    group: "loop",
    description:
      "Remove the reasoning item and the function_call's `id` (so the API can't pair them).",
    apply: (b) => ({
      ...b,
      input: stripIds((b as Body).input.filter((i) => i.type !== "reasoning")),
    }),
  },
  {
    name: "strip_item_ids",
    group: "loop",
    description:
      "Keep every item but remove the `id`s from the reasoning item and function_call.",
    apply: (b) => ({ ...b, input: stripIds((b as Body).input) }),
  },
  {
    name: "reasoning_by_reference",
    group: "loop",
    description:
      "Replace the reasoning item with an `item_reference` to the stored item.",
    apply: (b) => ({
      ...b,
      input: (b as Body).input.map((i) =>
        i.type === "reasoning" ? { type: "item_reference", id: i.id } : i
      ),
    }),
  },
  {
    name: "output_items_by_reference",
    group: "loop",
    description:
      "Replace both the reasoning item and the function_call with `item_reference`s.",
    apply: (b) => ({
      ...b,
      input: (b as Body).input.map((i) =>
        i.type === "reasoning" || i.type === "function_call"
          ? { type: "item_reference", id: i.id }
          : i
      ),
    }),
  },
  {
    name: "previous_response_id",
    group: "loop",
    description:
      "Send `previous_response_id` plus only the tool result, instead of the full input.",
    apply: (b, { seed }) => ({
      ...b,
      previous_response_id: seed!.id,
      input: (b as Body).input.filter(isType("function_call_output")),
    }),
  },
  {
    name: "tool_output_edit",
    group: "loop",
    description: "Append a word to the tool result.",
    apply: (b) => {
      const out = (b as Body).input.find(isType("function_call_output"))!;
      out.output = editEnd(out.output as string);
      return b;
    },
  },
  {
    name: "then_user_turn",
    group: "loop",
    description:
      "Append the assistant's final reply and a new user message after the tool result.",
    apply: (b, { fixture }) => {
      (b as Body).input.push(
        { role: "assistant", content: "ok" },
        { role: "user", content: `${fixture.extraTurn}. Reply with ok.` }
      );
      return b;
    },
  },
  {
    name: "then_user_turn_no_reasoning",
    group: "loop",
    description:
      "As then_user_turn, but also drop the earlier reasoning item (and item ids).",
    apply: (b, { fixture }) => {
      const body = b as Body;
      body.input = stripIds(body.input.filter((i) => i.type !== "reasoning"));
      body.input.push(
        { role: "assistant", content: "ok" },
        { role: "user", content: `${fixture.extraTurn}. Reply with ok.` }
      );
      return body;
    },
  },
  {
    name: "effort_medium",
    group: "reasoning",
    description: "`reasoning.effort` low → medium mid-loop.",
    apply: (b) => ({ ...b, reasoning: { effort: "medium" } }),
  },
];

export const openaiResponsesToolLoop: ToolLoop = {
  buildBase: buildToolLoopBase,
  variants: toolLoopVariants,
};

/**
 * The same API on gpt-5.5, which matches cached prefixes in fixed-size
 * blocks rather than whole messages. Its sibling for model_switch is gpt-5.4.
 */
export const openaiResponses55: Adapter = {
  name: "openai_responses_gpt-5.5",
  provider: "openai_responses",
  defaultModel: "gpt-5.5",
  altModel: "gpt-5.4",
  render: renderResponses,
  send,
  variants: responsesVariants,
  toolLoop: openaiResponsesToolLoop,
};

export const openaiResponses: Adapter = {
  name: "openai_responses",
  provider: "openai_responses",
  defaultModel: "gpt-5.6-sol",
  altModel: "gpt-5.6-luna",
  render: renderResponses,
  send,
  variants: responsesVariants,
  toolLoop: openaiResponsesToolLoop,
};
