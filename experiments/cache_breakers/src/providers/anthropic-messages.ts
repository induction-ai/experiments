// Anthropic Messages API. Caching needs a `cache_control` marker, so this
// adapter comes in two modes:
//   auto:        one top-level `cache_control` (the API places the breakpoint
//                on the last block): the closest thing to implicit caching.
//   breakpoints: an explicit breakpoint at the end of the tools, the system
//                prompt, the early exchange and the late exchange (4, the
//                maximum), so reads can land on every section boundary.
// Raw HTTP rather than the SDK, like the other adapters: the experiment is
// about exact wire bodies, and one transport keeps the providers comparable.
import { getApiKey } from "@experiments/shared";
import {
  book,
  editEnd,
  editStart,
  mulberry32,
  type Fixture,
  type ToolDef,
} from "../fixture.js";
import type {
  Adapter,
  CallResult,
  Json,
  ToolLoop,
  Usage,
  Variant,
} from "./types.js";

const URL = "https://api.anthropic.com/v1/messages";
export type CacheMode = "auto" | "breakpoints";

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const EPHEMERAL = { type: "ephemeral" };

// messages layout: [early user, early assistant, late user, late assistant, final user]
const EARLY = 0;
const LATE = 2;
const FINAL = 4;

type Block = Json & { type: string; text?: string };
type Msg = Json & { role: string; content: string | Block[] };
type Body = Json & {
  tools?: Json[];
  system: string | Block[];
  messages: Msg[];
};

/** Request field holding beta flags; moved to the `anthropic-beta` header on send. */
export const BETAS = "__betas";

function tool(t: ToolDef): Json {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  };
}

function textBlock(text: string, mark: boolean): Block {
  return mark
    ? { type: "text", text, cache_control: EPHEMERAL }
    : { type: "text", text };
}

export function renderAnthropic(
  fixture: Fixture,
  model: string,
  mode: CacheMode
): Json {
  const mark = mode === "breakpoints";
  const tools = fixture.tools.map(tool);
  if (mark) tools[tools.length - 1]!.cache_control = EPHEMERAL;
  const msg = (role: string, text: string, marked: boolean): Msg =>
    marked
      ? { role, content: [textBlock(text, true)] }
      : { role, content: text };
  const body: Json = {
    model,
    max_tokens: 256,
    output_config: { effort: "low" },
    tools,
    system: mark ? [textBlock(fixture.system, true)] : fixture.system,
    messages: [
      msg("user", fixture.early[0].text, false),
      msg("assistant", fixture.early[1].text, mark),
      msg("user", fixture.late[0].text, false),
      msg("assistant", fixture.late[1].text, mark),
      msg("user", fixture.final, false),
    ],
  };
  if (mode === "auto") body.cache_control = EPHEMERAL;
  return body;
}

export function parseAnthropicUsage(body: Json): Usage | null {
  const u = body.usage as
    | {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined;
  if (!u) return null;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return {
    // input_tokens is only the uncached remainder; the prompt is the sum.
    input: u.input_tokens + read + write,
    cached: read,
    cacheWrite: write,
    output: u.output_tokens,
    reasoning: null,
  };
}

async function send(body: Json): Promise<CallResult> {
  const { [BETAS]: betas, ...wire } = body;
  const headers: Record<string, string> = {
    "x-api-key": getApiKey("anthropic"),
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  if (Array.isArray(betas) && betas.length) {
    headers["anthropic-beta"] = betas.join(",");
  }
  const res = await fetch(URL, {
    method: "POST",
    headers,
    body: JSON.stringify(wire),
  });
  const json = (await res.json()) as Json;
  const err = json.error as { message?: string } | undefined;
  if (!res.ok) {
    return {
      status: res.status,
      usage: null,
      error: err?.message ?? `HTTP ${res.status}`,
      body: json,
    };
  }
  // A refusal is a 200 whose usage is real but whose prompt isn't cached
  // (observed: refused requests write every time and never read), so it
  // can't be a valid trial.
  if (json.stop_reason === "refusal") {
    const d = json.stop_details as { category?: string } | null;
    return {
      status: res.status,
      usage: parseAnthropicUsage(json),
      error: `refusal (${d?.category ?? "unknown"})`,
      body: json,
    };
  }
  return {
    status: res.status,
    usage: parseAnthropicUsage(json),
    error: null,
    body: json,
  };
}

// --- edits that work in both modes (string or block content) ---------------

function textOf(m: Msg): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => b.text ?? "").join("");
}

function editMessage(
  body: Json,
  index: number,
  edit: (s: string) => string
): Json {
  const m = (body as Body).messages[index]!;
  if (typeof m.content === "string") m.content = edit(m.content);
  else {
    const b = m.content[0]!;
    b.text = edit(b.text!);
  }
  return body;
}

function editSystem(body: Json, edit: (s: string) => string): Json {
  const b = body as Body;
  if (typeof b.system === "string") b.system = edit(b.system);
  else b.system[0]!.text = edit(b.system[0]!.text!);
  return b;
}

/** Keep any breakpoint on the last tool after the tool list changes. */
function remarkTools(tools: Json[], mode: CacheMode) {
  for (const t of tools) delete t.cache_control;
  if (mode === "breakpoints" && tools.length) {
    tools[tools.length - 1]!.cache_control = EPHEMERAL;
  }
}

const set =
  (patch: Json) =>
  (b: Json): Json => ({ ...b, ...patch });

export const ANTHROPIC_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const withEffort = (effort: string) => (b: Json) => ({
  ...b,
  output_config: { ...(b.output_config as Json), effort },
});

function effortVariants(): Variant[] {
  const out: Variant[] = [];
  for (const from of ANTHROPIC_EFFORTS) {
    for (const to of ANTHROPIC_EFFORTS) {
      if (from === to) continue;
      out.push({
        name: `effort_${from}_to_${to}`,
        group: "reasoning",
        description: `\`output_config.effort\` ${from} → ${to}.`,
        rebase: withEffort(from),
        apply: withEffort(to),
      });
    }
    out.push({
      name: `effort_${from}_omitted`,
      group: "reasoning",
      description: `Warm at \`effort: ${from}\`, then omit \`output_config\`.`,
      rebase: withEffort(from),
      apply: (b) => {
        delete b.output_config;
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

function staticVariants(mode: CacheMode): Variant[] {
  return [
    {
      name: "control",
      group: "control",
      description: "Resend the base request unchanged.",
      apply: (b) => b,
    },
    {
      name: "tools_edit_start",
      group: "probe",
      description:
        "Edit the tools: change the first character of the first tool description.",
      apply: (b) => {
        const t = (b as Body).tools![0]!;
        t.description = editStart(t.description as string);
        return b;
      },
    },
    {
      name: "tools_edit_end",
      group: "probe",
      description:
        "Edit the tools: append a word to the last tool description.",
      apply: (b) => {
        const ts = (b as Body).tools!;
        const t = ts[ts.length - 1]!;
        t.description = editEnd(t.description as string);
        return b;
      },
    },
    {
      name: "system_edit_start",
      group: "probe",
      description:
        "Edit the system prompt: change the first character of `system`.",
      apply: (b) => editSystem(b, editStart),
    },
    {
      name: "system_edit_end",
      group: "probe",
      description: "Edit the system prompt: append a word to `system`.",
      apply: (b) => editSystem(b, editEnd),
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
    {
      name: "prev_turn_then_final_edit",
      group: "probe",
      description:
        "Also send the previous turn (messages up to the late user message), then edit the final message.",
      prewarm: (b) => [
        { ...b, messages: (b as Body).messages.slice(0, LATE + 1) },
      ],
      apply: (b) => editMessage(b, FINAL, editEnd),
    },
    {
      name: "prev_turn_then_late_reply_edit",
      group: "probe",
      description:
        "Also send the previous turn, then edit the assistant reply that followed it.",
      prewarm: (b) => [
        { ...b, messages: (b as Body).messages.slice(0, LATE + 1) },
      ],
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
          messages: [
            ...(b as Body).messages.slice(0, LATE),
            { role: "user", content: `${fixture.extraTurn}. Reply with ok.` },
          ],
        },
      ],
      apply: (b) => editMessage(b, LATE, editEnd),
    },

    // Tools
    {
      name: "tool_add",
      group: "tools",
      description: "Append one more tool definition.",
      apply: (b, { fixture }) => {
        const ts = (b as Body).tools!;
        ts.push(tool(fixture.extraTool));
        remarkTools(ts, mode);
        return b;
      },
    },
    {
      name: "tool_remove_last",
      group: "tools",
      description: "Drop the last tool definition.",
      apply: (b) => {
        const ts = (b as Body).tools!;
        ts.pop();
        remarkTools(ts, mode);
        return b;
      },
    },
    {
      name: "tools_reorder",
      group: "tools",
      description: "Swap the last two tool definitions.",
      apply: (b) => {
        const t = (b as Body).tools!;
        const n = t.length;
        [t[n - 2], t[n - 1]] = [t[n - 1]!, t[n - 2]!];
        remarkTools(t, mode);
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
      name: "tool_strict_on",
      group: "tools",
      description: "`strict` on every tool: unset → true.",
      apply: (b) => {
        for (const t of (b as Body).tools!) t.strict = true;
        return b;
      },
    },
    {
      name: "tool_schema_key_order",
      group: "tools",
      description:
        "Reorder JSON keys inside the last tool's input schema (same meaning).",
      apply: (b) => {
        const ts = (b as Body).tools!;
        const t = ts[ts.length - 1]!;
        const p = t.input_schema as Json;
        t.input_schema = {
          additionalProperties: p.additionalProperties,
          required: p.required,
          properties: p.properties,
          type: p.type,
        };
        return b;
      },
    },
    {
      name: "tool_choice_any",
      group: "tools",
      description: "`tool_choice`: auto (default) → `any`.",
      apply: set({ tool_choice: { type: "any" } }),
    },
    {
      name: "tool_choice_none",
      group: "tools",
      description: "`tool_choice`: auto (default) → `none`.",
      apply: set({ tool_choice: { type: "none" } }),
    },
    {
      name: "tool_choice_tool",
      group: "tools",
      description: "`tool_choice`: auto (default) → the first tool by name.",
      apply: (b) => ({
        ...b,
        tool_choice: { type: "tool", name: (b as Body).tools![0]!.name },
      }),
    },
    {
      name: "disable_parallel_tool_use",
      group: "tools",
      description: "`disable_parallel_tool_use`: false (default) → true.",
      apply: set({
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      }),
    },

    // System prompt
    {
      name: "system_as_blocks",
      group: "system",
      description:
        mode === "auto"
          ? "Send `system` as `[{type: text}]` instead of a string (same text)."
          : "Send `system` as a string instead of a marked block (drops its breakpoint).",
      apply: (b) => {
        const body = b as Body;
        body.system =
          typeof body.system === "string"
            ? [{ type: "text", text: body.system }]
            : body.system[0]!.text!;
        return body;
      },
    },
    {
      name: "system_message_appended",
      group: "system",
      description:
        "Append a mid-conversation `{role: system}` message after the final user message.",
      apply: (b) => {
        (b as Body).messages.push({
          role: "system",
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
        (b as Body).messages.push(
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
        const m = (b as Body).messages[FINAL]!;
        m.content = [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: PIXEL_PNG,
            },
          },
          { type: "text", text: textOf(m) },
        ];
        return b;
      },
    },
    {
      name: "content_as_parts",
      group: "messages",
      description:
        "Send the first message as `[{type: text}]` instead of a string (same text).",
      apply: (b) => {
        const m = (b as Body).messages[EARLY]!;
        m.content = [{ type: "text", text: textOf(m) }];
        return b;
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
    ...effortVariants(),
    {
      name: "thinking_disabled",
      group: "reasoning",
      description: "`thinking`: adaptive (default) → disabled.",
      apply: set({ thinking: { type: "disabled" } }),
    },
    {
      name: "thinking_adaptive_explicit",
      group: "reasoning",
      description:
        "`thinking: {type: adaptive}` sent explicitly (the default when omitted).",
      apply: set({ thinking: { type: "adaptive" } }),
    },
    {
      name: "thinking_display_summarized",
      group: "reasoning",
      description: '`thinking: {type: adaptive, display: "summarized"}`.',
      apply: set({ thinking: { type: "adaptive", display: "summarized" } }),
    },
    {
      name: "beta_header_only",
      group: "reasoning",
      description:
        "Send the per-message-effort beta header alone, with no effort message.",
      apply: (b) => ({
        ...b,
        [BETAS]: ["mid-conversation-output-config-2026-07-01"],
      }),
    },
    {
      name: "effort_per_message",
      group: "reasoning",
      description:
        "Change effort to medium with a mid-conversation effort-only system message (beta).",
      apply: (b) => {
        (b as Body).messages.push({
          role: "system",
          content: [],
          output_config: { effort: "medium" },
        });
        return { ...b, [BETAS]: ["mid-conversation-output-config-2026-07-01"] };
      },
    },

    // Output
    {
      name: "max_tokens",
      group: "output",
      description: "`max_tokens`: 256 → 512.",
      apply: set({ max_tokens: 512 }),
    },
    {
      name: "json_schema_format",
      group: "output",
      description:
        "`output_config.format`: plain text (default) → a JSON schema.",
      apply: (b) => ({
        ...b,
        output_config: {
          ...(b.output_config as Json),
          format: {
            type: "json_schema",
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
      name: "stop_sequences",
      group: "output",
      description: '`stop_sequences`: none → `["###"]`.',
      apply: set({ stop_sequences: ["###"] }),
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

    // Routing, account and cache fields
    {
      name: "metadata_user_id",
      group: "routing",
      description: "`metadata.user_id`: unset → a synthetic id.",
      apply: set({ metadata: { user_id: "synthetic-user-1" } }),
    },
    {
      name: "service_tier_standard_only",
      group: "routing",
      description: '`service_tier`: auto (default) → `"standard_only"`.',
      apply: set({ service_tier: "standard_only" }),
    },
    {
      name: "inference_geo_us",
      group: "routing",
      description: '`inference_geo`: default → `"us"`.',
      apply: set({ inference_geo: "us" }),
    },
    {
      name: "cache_ttl_1h",
      group: "routing",
      description:
        mode === "auto"
          ? 'Top-level `cache_control` with `ttl: "1h"` (base: 5 minutes).'
          : 'Every breakpoint with `ttl: "1h"` (base: 5 minutes).',
      apply: (b) => {
        const oneHour = { type: "ephemeral", ttl: "1h" };
        if (mode === "auto") return { ...b, cache_control: oneHour };
        const body = b as Body;
        const ts = body.tools!;
        ts[ts.length - 1]!.cache_control = oneHour;
        (body.system as Block[])[0]!.cache_control = oneHour;
        for (const i of [EARLY + 1, LATE + 1]) {
          (body.messages[i]!.content as Block[])[0]!.cache_control = oneHour;
        }
        return body;
      },
    },
    {
      name: "cache_mode_switch",
      group: "routing",
      description:
        mode === "auto"
          ? "Replace top-level `cache_control` with one explicit breakpoint on the final message."
          : "Replace the explicit breakpoints with top-level `cache_control`.",
      apply: (b) => {
        const body = b as Body;
        if (mode === "auto") {
          delete body.cache_control;
          const m = body.messages[FINAL]!;
          m.content = [textBlock(textOf(m), true)];
          return body;
        }
        remarkTools(body.tools!, "auto");
        body.system = (body.system as Block[])[0]!.text!;
        for (const i of [EARLY + 1, LATE + 1]) {
          body.messages[i]!.content = textOf(body.messages[i]!);
        }
        body.cache_control = EPHEMERAL;
        return body;
      },
    },
  ];
}

// Tool loop: a live call makes the model think and call a tool; the base
// replays the assistant turn verbatim (thinking block with its signature,
// then tool_use) followed by a tool_result.

export function makeToolLoop(mode: CacheMode): ToolLoop {
  const buildBase = async (
    fixture: Fixture,
    model: string
  ): Promise<{ base: Json; seed: Json } | { error: string }> => {
    const first = renderAnthropic(fixture, model, mode) as Body;
    const t = fixture.tools[0]!;
    first.messages[FINAL] = {
      role: "user",
      content: `Work out 4817 * 293 and the number of letters in the longest word of the first message. Call ${t.name} with query set to the product and region set to that letter count. After the result, reply with ok.`,
    };
    const res = await send({ ...first, max_tokens: 4096 });
    if (res.error || !res.body) return { error: res.error ?? "no body" };
    const content = (res.body.content ?? []) as Block[];
    const call = content.find((c) => c.type === "tool_use");
    if (!call)
      return { error: `no tool_use (stop ${String(res.body.stop_reason)})` };
    if (!content.some((c) => c.type === "thinking")) {
      return { error: "no thinking block in output" };
    }
    const result = book(mulberry32(fixture.nonce.length + 7), 200);
    const base: Json = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: result },
          ],
        },
      ],
    };
    return { base, seed: res.body };
  };

  const assistantIndex = (b: Body) =>
    b.messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "tool_use")
    );

  const variants: Variant[] = [
    {
      name: "control",
      group: "control",
      description: "Resend the tool-loop base unchanged.",
      apply: (b) => b,
    },
    {
      name: "drop_thinking",
      group: "loop",
      description:
        "Remove the thinking block from the replayed assistant turn.",
      apply: (b) => {
        const body = b as Body;
        const m = body.messages[assistantIndex(body)]!;
        m.content = (m.content as Block[]).filter((c) => c.type !== "thinking");
        return body;
      },
    },
    {
      name: "thinking_signature_edit",
      group: "loop",
      description: "Change one character of the thinking block's signature.",
      apply: (b) => {
        const body = b as Body;
        const m = body.messages[assistantIndex(body)]!;
        const th = (m.content as Block[]).find((c) => c.type === "thinking")!;
        const sig = th.signature as string;
        th.signature = `${sig.slice(0, -2)}${sig.endsWith("A") ? "B" : "A"}${sig.slice(-1)}`;
        return body;
      },
    },
    {
      name: "tool_result_edit",
      group: "loop",
      description: "Append a word to the tool result.",
      apply: (b) => {
        const body = b as Body;
        const last = body.messages[body.messages.length - 1]!;
        const r = (last.content as Block[])[0]!;
        r.content = editEnd(r.content as string);
        return body;
      },
    },
    {
      name: "then_user_turn",
      group: "loop",
      description:
        "Append the assistant's final reply and a new user message after the tool result.",
      apply: (b, { fixture }) => {
        (b as Body).messages.push(
          { role: "assistant", content: "ok" },
          { role: "user", content: `${fixture.extraTurn}. Reply with ok.` }
        );
        return b;
      },
    },
    {
      name: "then_user_turn_drop_thinking",
      group: "loop",
      description:
        "As then_user_turn, but also drop the earlier thinking block.",
      apply: (b, { fixture }) => {
        const body = b as Body;
        const m = body.messages[assistantIndex(body)]!;
        m.content = (m.content as Block[]).filter((c) => c.type !== "thinking");
        body.messages.push(
          { role: "assistant", content: "ok" },
          { role: "user", content: `${fixture.extraTurn}. Reply with ok.` }
        );
        return body;
      },
    },
    {
      name: "effort_medium",
      group: "reasoning",
      description: "`output_config.effort` low → medium mid-loop.",
      apply: withEffort("medium"),
    },
  ];
  return { buildBase, variants };
}

function makeAdapter(mode: CacheMode): Adapter {
  return {
    name: `anthropic_${mode}`,
    provider: "anthropic_messages",
    fillerStyle: "book",
    defaultModel: "claude-opus-5",
    altModel: "claude-sonnet-5",
    render: (f, model) => renderAnthropic(f, model, mode),
    send,
    variants: staticVariants(mode),
    toolLoop: makeToolLoop(mode),
  };
}

export const anthropicAuto = makeAdapter("auto");
export const anthropicBreakpoints = makeAdapter("breakpoints");
