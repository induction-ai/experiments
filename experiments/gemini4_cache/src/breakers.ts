// The breakers probe: on a warm gemini-4-argon request, change exactly one
// thing and measure how much of the cache survives. The same idea as the
// cache_breakers experiment (OpenAI and Anthropic), with Gemini's fields.
//
// The base request has a system instruction, two tool declarations, a
// four-message history and a final user message, all seeded filler:
//
//   systemInstruction  SYSTEM words
//   tools              2 functions with DESC-word descriptions
//   contents           u_early, m_early, u_late, m_late (HISTORY words each),
//                      u_final (FINAL words)
//
// Per trial (fresh nonce): send the base until a send reports cached tokens
// (up to `maxWarm` sends), run the variant's `prewarm` requests if any, then
// send the variant once. Every request is also counted with countTokens, so a
// trial where argon's hidden block (see inflation.ts) switched on or off is
// flagged instead of blamed on the change.
import { filler } from "./filler.js";
import {
  countTokens,
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Json,
  type Request,
} from "./gemini.js";

export const SIZES = { SYSTEM: 1500, DESC: 600, HISTORY: 900, FINAL: 300 };

// A 1x1 PNG, for the "image in the final message" variant.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const user = (text: string): Content => ({ role: "user", parts: [{ text }] });
const model = (text: string): Content => ({ role: "model", parts: [{ text }] });

function tool(name: string, description: string): Json {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record id" },
        limit: { type: "integer", description: "Maximum results" },
      },
      required: ["id"],
    },
  };
}

/** The warm base request for one trial. */
export function baseRequest(seed: number, nonce: string): Request {
  const s = (k: number, label: string, n: number) => filler(seed + k, label, n);
  return {
    systemInstruction: { parts: [{ text: s(0, nonce, SIZES.SYSTEM) }] },
    tools: [
      {
        functionDeclarations: [
          tool("lookup_record", s(1, "tool one", SIZES.DESC)),
          tool("list_records", s(2, "tool two", SIZES.DESC)),
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    contents: [
      user(s(3, "early question", SIZES.HISTORY)),
      model(s(4, "early answer", SIZES.HISTORY)),
      user(s(5, "late question", SIZES.HISTORY)),
      model(s(6, "late answer", SIZES.HISTORY)),
      user(`${s(7, "final", SIZES.FINAL)}\n\nReply with the single word OK.`),
    ],
    generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 256 },
  };
}

export type Group =
  | "control"
  | "content"
  | "tools"
  | "thread"
  | "generation"
  | "toolConfig"
  | "other";

export interface Breaker {
  name: string;
  group: Group;
  description: string;
  apply: (base: Request) => Request;
  /** Requests sent once after the base is warm and before the variant. */
  prewarm?: (base: Request) => Request[];
}

const clone = (r: Request): Request => structuredClone(r);
const withoutTools = (r: Request): Request => {
  const b = clone(r);
  delete b.tools;
  delete b.toolConfig;
  return b;
};
const appendWord = (p: { text?: string }) => {
  p.text = `${p.text} zebra`;
};
const fns = (r: Request) =>
  (r.tools![0] as { functionDeclarations: Json[] }).functionDeclarations;
const gen = (r: Request, patch: Json): Request => {
  const b = clone(r);
  b.generationConfig = { ...b.generationConfig, ...patch };
  return b;
};
const editContent = (i: number) => (r: Request) => {
  const b = clone(r);
  appendWord(b.contents[i]!.parts.at(-1)!);
  return b;
};

export const BREAKERS: Breaker[] = [
  {
    name: "control",
    group: "control",
    description: "Resend the base request unchanged.",
    apply: clone,
  },
  // ---- content edits
  {
    name: "system_edit_end",
    group: "content",
    description: "Append a word to the system instruction.",
    apply: (r) => {
      const b = clone(r);
      appendWord(b.systemInstruction!.parts[0]!);
      return b;
    },
  },
  {
    name: "early_edit_end",
    group: "content",
    description: "Append a word to the first history message.",
    apply: editContent(0),
  },
  {
    name: "late_question_edit_end",
    group: "content",
    description:
      "Append a word to the third history message (the late question), the message the cached span ends in.",
    apply: editContent(2),
  },
  {
    name: "late_edit_end",
    group: "content",
    description:
      "Append a word to the fourth history message (the last model turn).",
    apply: editContent(3),
  },
  {
    name: "final_edit",
    group: "content",
    description: "Append a word to the final user message.",
    apply: editContent(4),
  },
  {
    name: "image_in_final",
    group: "content",
    description: "Add a 1x1 PNG to the final user message.",
    apply: (r) => {
      const b = clone(r);
      b.contents[4]!.parts.push({
        inlineData: { mimeType: "image/png", data: PIXEL_PNG },
      } as never);
      return b;
    },
  },
  {
    name: "system_as_two_parts",
    group: "content",
    description:
      "Split the system instruction into two text parts (same text).",
    apply: (r) => {
      const b = clone(r);
      const t = b.systemInstruction!.parts[0]!.text!;
      const cut = t.indexOf(" ", Math.floor(t.length / 2));
      b.systemInstruction!.parts = [
        { text: t.slice(0, cut) },
        { text: t.slice(cut) },
      ];
      return b;
    },
  },
  // ---- tools
  {
    name: "tool_description_edit",
    group: "tools",
    description: "Append a word to the last tool’s description.",
    apply: (r) => {
      const b = clone(r);
      const f = fns(b).at(-1)! as { description: string };
      f.description = `${f.description} zebra`;
      return b;
    },
  },
  {
    name: "tool_add",
    group: "tools",
    description: "Append a third function declaration.",
    apply: (r) => {
      const b = clone(r);
      fns(b).push(tool("count_records", "Count catalogue records."));
      return b;
    },
  },
  {
    name: "tools_reorder",
    group: "tools",
    description: "Swap the two function declarations.",
    apply: (r) => {
      const b = clone(r);
      fns(b).reverse();
      return b;
    },
  },
  {
    name: "tools_remove_all",
    group: "tools",
    description: "Send no tools (and no toolConfig).",
    apply: (r) => {
      const b = clone(r);
      delete b.tools;
      delete b.toolConfig;
      return b;
    },
  },
  {
    name: "tool_schema_key_order",
    group: "tools",
    description: "Reorder the keys of the first tool’s parameter properties.",
    apply: (r) => {
      const b = clone(r);
      const p = (fns(b)[0] as { parameters: { properties: Json } }).parameters;
      p.properties = { limit: p.properties.limit, id: p.properties.id };
      return b;
    },
  },
  // ---- thread
  {
    name: "append_turn",
    group: "thread",
    description:
      "Append a model reply and a new user message (normal conversation growth).",
    apply: (r) => {
      const b = clone(r);
      b.contents.push(
        model("OK"),
        user("Thanks. Reply with the single word OK again.")
      );
      return b;
    },
  },
  {
    name: "prev_turn_then_final_edit",
    group: "thread",
    description:
      "First send the thread as it was one turn earlier (ending at the late question), then edit the final message.",
    prewarm: (r) => {
      const b = clone(r);
      b.contents = b.contents.slice(0, 3);
      return [b];
    },
    apply: editContent(4),
  },
  // ---- generation config
  {
    name: "temperature",
    group: "generation",
    description: "`temperature`: unset → 0.5.",
    apply: (r) => gen(r, { temperature: 0.5 }),
  },
  {
    name: "top_p",
    group: "generation",
    description: "`topP`: unset → 0.5.",
    apply: (r) => gen(r, { topP: 0.5 }),
  },
  {
    name: "max_output_tokens",
    group: "generation",
    description: "`maxOutputTokens`: 256 → 512.",
    apply: (r) => gen(r, { maxOutputTokens: 512 }),
  },
  {
    name: "stop_sequences",
    group: "generation",
    description: '`stopSequences`: none → `["###"]`.',
    apply: (r) => gen(r, { stopSequences: ["###"] }),
  },
  {
    name: "seed",
    group: "generation",
    description: "`seed`: unset → 7.",
    apply: (r) => gen(r, { seed: 7 }),
  },
  {
    name: "thinking_high",
    group: "generation",
    description: "`thinkingLevel`: low → high.",
    apply: (r) => gen(r, { thinkingConfig: { thinkingLevel: "high" } }),
  },
  {
    name: "thinking_omitted",
    group: "generation",
    description: "Omit `thinkingConfig` (the model’s default).",
    apply: (r) => {
      const b = clone(r);
      const { thinkingConfig: _t, ...rest } = b.generationConfig as Json;
      b.generationConfig = rest;
      return b;
    },
  },
  {
    name: "include_thoughts",
    group: "generation",
    description: "`thinkingConfig.includeThoughts`: unset → true.",
    apply: (r) =>
      gen(r, {
        thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
      }),
  },
  {
    name: "json_mime_type",
    group: "generation",
    description:
      '`responseMimeType`: unset → `"application/json"`. JSON mode can’t be combined with tools, so a copy of the base without tools is warmed first and the variant is that copy in JSON mode.',
    prewarm: (r) => [withoutTools(r), withoutTools(r)],
    apply: (r) => {
      const b = withoutTools(r);
      b.generationConfig = {
        ...b.generationConfig,
        responseMimeType: "application/json",
      };
      return b;
    },
  },
  {
    name: "no_tools_control",
    group: "control",
    description:
      "Control for json_mime_type: warm a copy of the base without tools, then resend it unchanged.",
    prewarm: (r) => [withoutTools(r), withoutTools(r)],
    apply: withoutTools,
  },
  // ---- toolConfig
  {
    name: "tool_mode_any",
    group: "toolConfig",
    description: "`functionCallingConfig.mode`: AUTO → ANY.",
    apply: (r) => {
      const b = clone(r);
      b.toolConfig = { functionCallingConfig: { mode: "ANY" } };
      return b;
    },
  },
  {
    name: "tool_mode_none",
    group: "toolConfig",
    description: "`functionCallingConfig.mode`: AUTO → NONE.",
    apply: (r) => {
      const b = clone(r);
      b.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      return b;
    },
  },
  {
    name: "tool_config_omitted",
    group: "toolConfig",
    description: "Omit `toolConfig` (AUTO is the default).",
    apply: (r) => {
      const b = clone(r);
      delete b.toolConfig;
      return b;
    },
  },
  // ---- other request fields
  {
    name: "safety_settings",
    group: "other",
    description:
      "Add one `safetySettings` entry (harassment: BLOCK_ONLY_HIGH).",
    apply: (r) => {
      const b = clone(r) as Request & { safetySettings?: Json[] };
      b.safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      ];
      return b;
    },
  },
];

export interface BreakerTrial {
  basePrompt: number | null;
  baseCached: number | null;
  baseCounted: number | null;
  warmSends: number;
  prompt: number | null;
  cached: number | null;
  counted: number | null;
  error: string | null;
}

export async function runBreaker(opts: {
  model: string;
  breaker: Breaker;
  seed: number;
  nonce: string;
  maxWarm: number;
  delayMs: number;
}): Promise<BreakerTrial> {
  const out: BreakerTrial = {
    basePrompt: null,
    baseCached: null,
    baseCounted: null,
    warmSends: 0,
    prompt: null,
    cached: null,
    counted: null,
    error: null,
  };
  const base = baseRequest(opts.seed, opts.nonce);
  for (let i = 0; i < opts.maxWarm; i++) {
    const r = await generate(opts.model, base);
    out.warmSends++;
    if (!r.usage) return { ...out, error: r.error };
    out.basePrompt = r.usage.prompt;
    out.baseCached = r.usage.cached;
    await sleep(opts.delayMs);
    if (r.usage.cached > 0) break;
  }
  for (const p of opts.breaker.prewarm?.(base) ?? []) {
    const r = await generate(opts.model, p);
    if (!r.usage) return { ...out, error: `prewarm: ${r.error}` };
    await sleep(opts.delayMs);
  }
  const variant = opts.breaker.apply(base);
  const r = await generate(opts.model, variant);
  if (!r.usage) return { ...out, error: r.error };
  out.prompt = r.usage.prompt;
  out.cached = r.usage.cached;
  try {
    out.baseCounted = await countTokens(opts.model, base);
    out.counted = await countTokens(opts.model, variant);
  } catch (e) {
    out.error = `countTokens: ${String(e).slice(0, 200)}`;
  }
  return out;
}
