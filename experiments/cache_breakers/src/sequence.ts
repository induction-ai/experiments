// A random thread of reader actions (src/threads.ts), sent live one request
// at a time, with the engine's prediction for each request next to what the
// API read. This is the check that the blog's tool, which stacks changes the
// experiment only measured one at a time, predicts real threads.
import { getApiKey } from "@experiments/shared";
import { simulate, type Block, type Outcome, type Rules } from "./engine.js";
import { book, buildFixture, mulberry32, words, type Fixture } from "./fixture.js";
import { BETAS } from "./providers/anthropic-messages.js";
import { configurationUpdate } from "./providers/openai-responses.js";
import type { Adapter, Json } from "./providers/types.js";
import { SETTINGS } from "./rules.js";
import {
  allowed,
  apply,
  BASE_EFFORT,
  contentKey,
  initialDraft,
  toBlocks,
  turns,
  type Action,
  type Draft,
  type Part,
} from "./threads.js";

export interface SequenceRow {
  provider: string;
  model: string;
  seed: number;
  nonce: string;
  step: number;
  action: string;
  params: string;
  input: number | null;
  cached: number | null;
  predicted: number | null;
  /** The request the prediction reads from (0-based), or empty. */
  predicted_from: number | null;
  predicted_unknown: boolean;
  /** Tokens the engine drew this request as (counted). */
  counted: number | null;
  error: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The inverse of actionName: "next", "edit u1 end", "set effort=medium"… */
export function parseAction(s: string): Action {
  const [kind, a, b] = s.trim().split(/\s+/);
  switch (kind) {
    case "next":
    case "resend":
      return { kind };
    case "edit":
      return { kind, stem: a!, at: b === "start" ? "start" : "end" };
    case "branch":
    case "cut":
      return { kind, turn: Number(a) };
    case "set": {
      const [name, value] = a!.split("=");
      return { kind, name: name!, value: value! };
    }

  }
  throw new Error(`unknown action: ${s}`);
}

export function actionName(a: Action): string {
  switch (a.kind) {
    case "edit":
      return `edit ${a.stem} ${a.at}`;
    case "branch":
    case "cut":
      return `${a.kind} ${a.turn}`;
    case "set":
      return `set ${a.name}=${a.value}`;

    default:
      return a.kind;
  }
}

/** One random action that applies to the draft and changes something. */
export function randomAction(
  rng: () => number,
  d: Draft,
  rules: Rules
): Action {
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
  for (;;) {
    const r = rng();
    let a: Action;
    if (r < 0.35) a = { kind: "next" };
    else if (r < 0.5) {
      a = {
        kind: "edit",
        stem: pick(d.parts.filter((p) => p.role !== "update")).stem,
        at: rng() < 0.5 ? "start" : "end",
      };
    } else if (r < 0.57) a = { kind: "branch", turn: 1 + Math.floor(rng() * turns(d)) };
    else if (r < 0.64) a = { kind: "cut", turn: 1 + Math.floor(rng() * turns(d)) };
    else if (r < 0.7) a = { kind: "resend" };
    else {
      // Only settings this API has, so every live step tests a rule.
      const names = SETTINGS.map((s) => s.name).filter((n) => rules.params[n]);
      const name = pick(names);
      const rule = rules.params[name]!;
      const current = d.params[name] ?? rule.initial;
      const value = pick(rule.values.filter((v) => v !== current));
      a = { kind: "set", name, value };
    }
    if (allowed(d, a)) return a;
  }
}

// --- rendering a draft for one adapter ----------------------------------

/** The input items after the header: messages, and updates on GPT-6. */
const conversation = (adapter: Adapter, d: Draft): Part[] =>
  d.parts.filter(
    (p) =>
      p.role === "user" ||
      p.role === "reply" ||
      (p.role === "update" && adapter.effortUpdates)
  );

interface Texts {
  /** Text of each part's current content, by content key. */
  byKey: Map<string, string>;
}

function edited(text: string, at: "start" | "end", version: number): string {
  // The version keeps every edit's text distinct, as the engine assumes.
  return at === "start"
    ? `Revision ${version}. ${text}`
    : `${text} (revision ${version})`;
}

/** Text for every part of the draft; fresh stems get fresh filler. */
function textFor(
  texts: Texts,
  p: Part,
  rng: () => number,
  fill: (rng: () => number, n: number) => string,
  nonce: string
): string {
  const key = contentKey(p);
  let t = texts.byKey.get(key);
  if (t === undefined) {
    t =
      p.role === "user"
        ? `[${nonce}] Turn ${p.turn}. ${fill(rng, 150)}`
        : fill(rng, 500);
    texts.byKey.set(key, t);
  }
  return t;
}

function applySettings(
  adapter: Adapter,
  body: Json,
  params: Record<string, string>,
  fixture: Fixture
): Json {
  const openai = adapter.provider === "openai_responses";
  const variant = (name: string) =>
    adapter.variants.find((v) => v.name === name)!;
  let b: Json = { ...body };
  const ctx = { fixture, altModel: adapter.altModel };
  if (params.model === "sibling") b = variant("model_switch").apply(b, ctx);
  if (params.format === "json") b = variant("json_schema_format").apply(b, ctx);
  if (params.max_output === "512") {
    b = variant(openai ? "max_output_tokens" : "max_tokens").apply(b, ctx);
  }
  if (params.tier === "other") {
    b = variant(
      openai ? "service_tier_priority" : "service_tier_standard_only"
    ).apply(b, ctx);
  }
  if (params.tool_choice === "required") {
    b = variant(openai ? "tool_choice_required" : "tool_choice_any").apply(b, ctx);
  }
  // GPT-6 keeps the request-level effort and changes it with update items.
  const effort = adapter.effortUpdates
    ? BASE_EFFORT
    : (params.effort ?? BASE_EFFORT);
  if (openai) {
    b.reasoning = {
      effort,
      ...(params.summary === "on" ? { summary: "auto" } : {}),
    };
  } else {
    b.output_config = { ...(b.output_config as Json), effort };
    if (params.summary === "on") {
      b = variant("thinking_display_summarized").apply(b, ctx);
    }
  }
  return b;
}

/** The request body for a draft; `upTo` truncates the messages (counting). */
function render(
  adapter: Adapter,
  d: Draft,
  model: string,
  base: Fixture,
  texts: Texts,
  rng: () => number,
  nonce: string,
  opts: { upTo?: number; settings: boolean }
): Json {
  const fill = adapter.fillerStyle === "book" ? book : words;
  const tools = d.parts.find((p) => p.role === "tools")!;
  const system = d.parts.find((p) => p.role === "system")!;
  // Tool and system edits are text edits of the fixture, keyed like messages.
  const fixture: Fixture = {
    ...base,
    tools: base.tools.map((t, i) => {
      const at = texts.byKey.get(`tools:edit@${tools.version}`);
      if (tools.version === 0 || !at) return t;
      const first = at === "start" && i === 0;
      const last = at === "end" && i === base.tools.length - 1;
      return first || last
        ? { ...t, description: edited(t.description, at as "start" | "end", tools.version) }
        : t;
    }),
    system: texts.byKey.get(contentKey(system)) ?? base.system,
  };
  const body = adapter.render(fixture, model);
  const key = "input" in body ? "input" : "messages";
  const msgs: Json[] = conversation(adapter, d)
    .map((p) =>
      p.role === "update"
        ? configurationUpdate(p.value!)
        : {
            role: p.role === "user" ? "user" : "assistant",
            content: textFor(texts, p, rng, fill, nonce),
          }
    )
    .slice(0, opts.upTo);
  const marked = adapter.name === "anthropic_breakpoints";
  const out: Json = {
    ...body,
    [key]: msgs.map((m, i) =>
      marked && i === msgs.length - 1
        ? {
            role: m.role,
            content: [
              {
                type: "text",
                text: m.content,
                cache_control: { type: "ephemeral" },
              },
            ],
          }
        : m
    ),
  };
  return opts.settings ? applySettings(adapter, out, d.params, fixture) : out;
}

// --- counting ----------------------------------------------------------

const countCache = new Map<string, number>();

async function countTokens(adapter: Adapter, body: Json): Promise<number> {
  const k = `${adapter.provider}:${JSON.stringify(body)}`;
  const hit = countCache.get(k);
  if (hit !== undefined) return hit;
  let n: number;
  for (let attempt = 0; ; attempt++) {
    const res =
      adapter.provider === "openai_responses"
        ? await fetch("https://api.openai.com/v1/responses/input_tokens", {
            method: "POST",
            headers: {
              authorization: `Bearer ${getApiKey("openai")}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(
              (({ max_output_tokens, store, prompt_cache_key, service_tier, ...rest }) => rest)(
                body as Record<string, unknown>
              )
            ),
          })
        : await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
            method: "POST",
            headers: {
              "x-api-key": getApiKey("anthropic"),
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify(
              (({ max_tokens, cache_control, service_tier, [BETAS]: _b, ...rest }) => rest)(
                body as Record<string, unknown>
              )
            ),
          });
    const json = (await res.json()) as { input_tokens?: number; error?: { message?: string } };
    if (res.ok && typeof json.input_tokens === "number") {
      n = json.input_tokens;
      break;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 3) {
      throw new Error(`count: ${json.error?.message ?? res.status}`);
    }
    await sleep(2000 * (attempt + 1));
  }
  countCache.set(k, n);
  return n;
}

/**
 * The draft as engine blocks, sized by counting prefixes of the request
 * (with its settings, since Anthropic renders tool_choice and thinking
 * display as tokens ahead of the messages): each message's size is the
 * growth of the count when it is added.
 *
 * The header points are counted at default settings, with a one-token
 * message standing in for "no messages" (both APIs need one), less a
 * constant: counted that way, the tools end and the system prompt end come
 * out HEADER_EXTRA tokens past where the cache reads them (calibrated on
 * two Anthropic threads, 71 and 75; ~8 on OpenAI).
 */
const HEADER_EXTRA: Record<string, number> = {
  openai_responses: 8,
  anthropic_messages: 74,
};

async function measureBlocks(
  adapter: Adapter,
  d: Draft,
  draw: Draw
): Promise<Block[]> {
  const messages = conversation(adapter, d);
  const counts: number[] = [];
  for (let i = 1; i <= messages.length; i++) {
    const body = draw(i, {}, true);
    try {
      counts.push(await countTokens(adapter, body));
    } catch (e) {
      // Anthropic won't count a prefix ending in an assistant message with
      // structured output on; count it with a one-token question after
      // (7 tokens on its own) instead.
      if (messages[i - 1]!.role !== "reply") throw e;
      const key = "input" in body ? "input" : "messages";
      const withDot = {
        ...body,
        [key]: [...(body[key] as Json[]), { role: "user", content: "." }],
      };
      counts.push((await countTokens(adapter, withDot)) - 7);
    }
  }
  const extra = HEADER_EXTRA[adapter.provider] ?? 0;
  const header = (await countTokens(adapter, draw(0, {}, false))) - extra;
  const toolsEnd =
    (await countTokens(adapter, draw(0, { system: true }, false))) - extra;
  // Each message's size, by its position among the messages.
  const sizes = counts.map((c, i) => c - (i === 0 ? header : counts[i - 1]!));
  return toBlocks(
    d,
    (p) =>
      p.role === "tools"
        ? toolsEnd
        : p.role === "system"
          ? header - toolsEnd
          : sizes[messages.indexOf(p)]!,
    { updates: adapter.effortUpdates }
  );
}

type Draw = (
  upTo: number | undefined,
  strip: { system?: boolean; tools?: boolean },
  settings: boolean
) => Json;

export async function runSequence(
  adapter: Adapter,
  rules: Rules,
  opts: {
    model: string;
    seed: number;
    nonce: string;
    steps: number;
    delayMs: number;
    /** A scripted thread instead of random actions (steps = its length + 1). */
    actions?: Action[];
  }
): Promise<SequenceRow[]> {
  const rng = mulberry32(opts.seed);
  const textRng = mulberry32(opts.seed + 7);
  const fixture = buildFixture({
    seed: opts.seed,
    nonce: opts.nonce,
    sectionWords: 600,
    style: adapter.fillerStyle,
  });
  const texts: Texts = { byKey: new Map() };
  texts.byKey.set("system@0", fixture.system);

  let draft = initialDraft();
  const rows: SequenceRow[] = [];
  const requests: { blocks: Block[]; params: Record<string, string> }[] = [];
  const steps = opts.actions ? opts.actions.length + 1 : opts.steps;
  for (let step = 0; step < steps; step++) {
    let action: Action | null = null;
    if (step > 0) {
      action = opts.actions?.[step - 1] ?? randomAction(rng, draft, rules);
      const before = draft;
      draft = apply(draft, action);
      if (action.kind === "edit") {
        const edit = action;
        const p = draft.parts.find((x) => x.stem === edit.stem)!;
        if (p.role === "tools") {
          texts.byKey.set(`tools:edit@${p.version}`, edit.at);
        } else {
          const old = before.parts.find((x) => x.stem === p.stem)!;
          const fill = adapter.fillerStyle === "book" ? book : words;
          const prev =
            p.role === "system"
              ? texts.byKey.get(contentKey(old))!
              : textFor(texts, old, textRng, fill, opts.nonce);
          texts.byKey.set(contentKey(p), edited(prev, edit.at, p.version));
        }
      }
    }
    const draw: Draw = (upTo, strip, settings) => {
      const b = render(adapter, draft, opts.model, fixture, texts, textRng, opts.nonce, {
        upTo,
        settings,
      });
      const key = "input" in b ? "input" : "messages";
      if (upTo === 0) b[key] = [{ role: "user", content: "." }];
      if (strip.system) {
        delete b.instructions;
        delete b.system;
      }
      if (strip.tools) delete b.tools;
      // Counts at default settings still use the request's model: Claude
      // Sonnet and Opus tokenize the same text differently.
      if (!settings && draft.params.model === "sibling") b.model = adapter.altModel;
      return b;
    };
    const row: SequenceRow = {
      provider: adapter.name,
      model: opts.model,
      seed: opts.seed,
      nonce: opts.nonce,
      step,
      action: action ? actionName(action) : "start",
      params: JSON.stringify(draft.params),
      input: null,
      cached: null,
      predicted: null,
      predicted_from: null,
      predicted_unknown: false,
      counted: null,
      error: "",
    };
    try {
      // Counted with the request's own settings: Anthropic renders some
      // (tool_choice, thinking display) as tokens ahead of the messages.
      const blocks = await measureBlocks(adapter, draft, draw);
      requests.push({ blocks, params: draft.params });
      const outcome: Outcome = simulate(rules, requests).at(-1)!;
      row.predicted = outcome.cached;
      row.predicted_from = outcome.from;
      row.predicted_unknown = outcome.unknown;
      row.counted = outcome.total;
    } catch (e) {
      row.error = String(e);
      rows.push(row);
      return rows;
    }
    if (step > 0) await sleep(opts.delayMs);
    const r = await adapter.send(draw(undefined, {}, true));
    if (r.error || !r.usage) {
      row.error = r.error ?? "no usage";
      rows.push(row);
      return rows;
    }
    // Seen twice on gpt-6-sol at xhigh/max effort: a 200 whose usage is all
    // zeros measures nothing about the cache.
    if (r.usage.input === 0) row.error = "usage reported 0 input tokens";
    row.input = r.usage.input;
    row.cached = r.usage.cached;
    rows.push(row);
  }
  return rows;
}
