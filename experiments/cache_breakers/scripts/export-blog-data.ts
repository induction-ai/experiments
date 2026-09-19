/**
 * Writes the data file for the blog post, so every cell and block in it
 * comes from results/*.csv. Re-run after any results change:
 *
 *   OUT=<path to the post's data.ts> pnpm export-blog
 *
 * Two exports: TABLE, the comparison (src/comparison.ts, the same rows and
 * words as the experiment page), and CASES, one drawing per row: the
 * requests in order (the change ringed, appended or named), then what the
 * last request read from cache on each API.
 *
 * All APIs are drawn on one layout measured on gpt-5.6-sol, whose cache
 * stops exactly at message ends: section sizes come from the probes that
 * stop at each boundary. Anthropic's counts are mapped onto that layout at
 * the same boundaries, measured on its own prompt; gpt-5.5 shares sol's
 * prompt and tokenizer, so its counts are used as tokens directly. Two
 * splits aren't measurable from cache reads and use the fixture's sizes:
 * tools vs system prompt, and a thread's user message vs reply.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  median,
  tier,
  toObs,
  usable,
  type Obs,
  type VariantSummary,
} from "../src/analyze.js";
import {
  aliasEffort,
  buildComparison,
  COLUMN_TITLES,
  COLUMNS,
  intactTurn,
  MAIN_SIZE,
  type Column,
  type Row,
} from "../src/comparison.js";
import { EFFORT_PAIRS } from "../src/concepts.js";
import { parseCsv } from "../src/csv.js";
import { ADAPTERS } from "../src/providers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const OUT = process.env.OUT;
if (!OUT) throw new Error("Set OUT to the blog post's data.ts path");

function rows(scenario: string): Record<string, string>[] {
  const dir = path.join(root, "results", scenario);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .flatMap((f) => parseCsv(fs.readFileSync(path.join(dir, f), "utf8")));
}

const allStatic: Obs[] = rows("static").map(toObs);
const threadRows = rows("thread");
const staticObs = (a: string): Obs[] =>
  allStatic.filter((o) => o.provider === a && o.section_words === MAIN_SIZE);

const med = (obs: Obs[], variant: string, field: "cached" | "base_cached") =>
  median(
    usable(obs.filter((o) => o.variant === variant)).map((o) => o[field]!)
  )!;

type Section = {
  label: string;
  tokens: number;
  changed?: boolean;
  /** A part request 1 didn't have. */
  added?: boolean;
};

// --- the single-request layout, measured on gpt-5.6-sol -----------------
const sol = staticObs("openai_responses");
const HEADER = med(sol, "early_edit_start", "cached"); // tools + system
const PREV = med(sol, "prev_turn_then_final_edit", "cached"); // … + user 2
const TOTAL = med(sol, "control", "base_cached");
const MESSAGE = Math.round((PREV - HEADER) / 3);
// The final message is a few tokens; rounding can leave it at or below 0,
// so floor it and take the difference out of the reply before it.
const FINAL = Math.max(TOTAL - HEADER - 4 * MESSAGE, 8);
const S: Section[] = [
  { label: "tools", tokens: Math.round(HEADER / 2) },
  { label: "system prompt", tokens: HEADER - Math.round(HEADER / 2) },
  { label: "user 1", tokens: MESSAGE },
  { label: "reply 1", tokens: MESSAGE },
  { label: "user 2", tokens: MESSAGE },
  { label: "reply 2", tokens: TOTAL - HEADER - 3 * MESSAGE - FINAL },
  { label: "final message", tokens: FINAL },
];
const endOf = (sections: Section[], label: string) => {
  let t = 0;
  for (const s of sections) {
    t += s.tokens;
    if (s.label === label) return t;
  }
  throw new Error(label);
};

/**
 * Adapters that stop on message boundaries land a few tokens either side of
 * the layout's boundary (random filler varies per trial), so a count within
 * a few dozen tokens of one is drawn on it.
 */
function snap(tokens: number): number {
  let t = 0;
  for (const s of S) {
    if (Math.abs(tokens - t) <= 40) return t;
    t += s.tokens;
  }
  return Math.abs(tokens - t) <= 40 ? t : tokens;
}

/** Map an adapter's cached count for one variant onto the layout. */
function toLayout(adapter: string, variant: string): number {
  const obs = staticObs(adapter);
  const cached = med(obs, variant, "cached");
  const base = med(obs, variant, "base_cached");
  // A full hit is drawn as one. The real uncached tails stay: gpt-5.5's
  // tokens after its last block point, and the final message after the
  // last explicit breakpoint.
  if (cached >= base - 16) {
    if (adapter === "openai_responses_gpt-5.5") return Math.min(cached, TOTAL);
    if (adapter === "anthropic_breakpoints") return endOf(S, "reply 2");
    return TOTAL;
  }
  if (adapter === "openai_responses_gpt-5.5") return Math.min(cached, TOTAL);
  if (adapter === "openai_responses") return snap(cached);
  // Anthropic: piecewise-linear between boundaries measured on its own
  // prompt (book text, so its token counts differ from the layout's).
  const frac = (v: string) =>
    med(obs, v, "cached") / med(obs, v, "base_cached");
  const anchors: [number, number][] =
    adapter === "anthropic_breakpoints"
      ? [
          [0, 0],
          [frac("system_edit_start"), endOf(S, "tools")],
          [frac("early_edit_start"), endOf(S, "system prompt")],
          [frac("late_edit_start"), endOf(S, "reply 1")],
          // Breakpoints end at reply 2; the final message is never cached.
          [1, endOf(S, "reply 2")],
        ]
      : [
          [0, 0],
          [frac("prev_turn_then_final_edit"), endOf(S, "user 2")],
          [1, TOTAL],
        ];
  const f = cached / base;
  for (let i = 1; i < anchors.length; i++) {
    const [f0, t0] = anchors[i - 1]!;
    const [f1, t1] = anchors[i]!;
    if (f <= f1 + 0.005) {
      return snap(
        Math.round(t0 + ((Math.min(f, f1) - f0) / (f1 - f0)) * (t1 - t0))
      );
    }
  }
  return endOf(S, "reply 2");
}

// --- the thread layout, measured on gpt-5.6-sol --------------------------
const solThread = threadRows.filter(
  (r) => r.provider === "openai_responses" && !r.error
);
const uEnds = [0, 1, 2, 3, 4, 5].map(
  (k) =>
    median(solThread.map((r) => Number(r.request_tokens!.split(";")[k]) - 3))!
);
// ~150-word user messages and ~500-word replies; the split isn't measurable
// from cache reads, so use the fixture's ratio.
const USER = Math.round((uEnds[1]! - uEnds[0]!) * (160 / 660));
const REPLY = Math.round(uEnds[1]! - uEnds[0]! - USER);
const THREAD_HEADER = Math.round(uEnds[0]! - USER);
const T: Section[] = [
  { label: "tools", tokens: Math.round(THREAD_HEADER / 2) },
  {
    label: "system prompt",
    tokens: THREAD_HEADER - Math.round(THREAD_HEADER / 2),
  },
  ...[1, 2, 3, 4, 5].flatMap((k) => [
    { label: `user ${k}`, tokens: USER },
    { label: `reply ${k}`, tokens: REPLY },
  ]),
  { label: "user 6", tokens: USER },
];
const upTo = (sections: Section[], label: string) =>
  sections.slice(0, sections.findIndex((s) => s.label === label) + 1);
const ring = (sections: Section[], label: string) =>
  sections.map((s) => (s.label === label ? { ...s, changed: true } : s));

// --- drawings -------------------------------------------------------------

type Billed =
  | { kind: "cached"; tokens: number }
  | { kind: "text"; text: string };

type Request = { label: string; sections: Section[]; tag?: string };

type Case = {
  id: string;
  title: string;
  alt: string;
  requests: Request[];
  billed: Record<Column, Billed>;
  note?: string;
};

type Draw = {
  /** Requests between request 1 and the billed one. */
  before?: Request[];
  /** The billed request's parts. */
  sections: Section[];
  tag: string;
  note?: string;
};

const tools = (text: string): Draw => ({
  sections: ring(S, "tools"),
  tag: text,
});
const param = (text: string, note?: string): Draw => ({
  sections: S,
  tag: text,
  note,
});
const added = (label: string, tokens: number): Section => ({
  label,
  tokens,
  added: true,
});

const DRAW: Record<string, Draw> = {
  resend: param("identical to request 1"),
  "edit-tool-description": tools(
    "first character of the first tool’s description changed"
  ),
  "edit-system-prompt-start": {
    sections: ring(S, "system prompt"),
    tag: "first character of the system prompt changed",
  },
  "edit-system-prompt-end": {
    sections: ring(S, "system prompt"),
    tag: "one word appended to the system prompt",
  },
  "edit-first-message-start": {
    sections: ring(S, "user 1"),
    tag: "first character of user message 1 changed",
  },
  "edit-first-message-end": {
    sections: ring(S, "user 1"),
    tag: "one word appended to user message 1",
  },
  "edit-third-message-start": {
    sections: ring(S, "user 2"),
    tag: "first character of user message 2 changed",
  },
  "edit-third-message-end": {
    sections: ring(S, "user 2"),
    tag: "one word appended to user message 2",
  },
  "edit-final-message": {
    sections: ring(S, "final message"),
    tag: "one word appended to the final message",
  },
  "edit-final-after-previous-turn": {
    before: [
      {
        label: "request 2",
        sections: upTo(S, "user 2"),
        tag: "the previous turn, sent once",
      },
    ],
    sections: ring(S, "final message"),
    tag: "one word appended to the final message",
  },
  "edit-after-diverging-request": {
    before: [
      {
        label: "request 2",
        sections: [
          ...upTo(S, "reply 1"),
          { label: "user 2", tokens: MESSAGE, changed: true },
        ],
        tag: "the same first exchange, then a different message, sent once",
      },
    ],
    sections: ring(S, "user 2"),
    tag: "one word appended to user message 2",
  },
  "append-turn": {
    sections: [...S, added("reply 3", 10), added("user 3", 50)],
    tag: "a reply and a new user message appended",
  },
  "add-image": {
    sections: ring(S, "final message"),
    tag: "a 1×1 image added to the final message",
  },
  "message-as-parts": {
    sections: ring(S, "user 1"),
    tag: "user message 1 sent as text parts instead of a string (same text)",
  },
  "change-tool-list": tools("one tool definition added"),
  "toggle-strict": tools("strict changed on every tool"),
  "reorder-schema-keys": tools(
    "keys reordered inside the last tool’s schema (same meaning)"
  ),
  "tool-choice-required": param(
    "tool_choice: auto → required (OpenAI) / any (Anthropic)"
  ),
  "tool-choice-named": param("tool_choice: auto → the first tool by name"),
  "tool-choice-none": param("tool_choice: auto → none"),
  "parallel-tool-calls-off": param(
    "parallel tool calls: allowed → off (OpenAI parallel_tool_calls, Anthropic disable_parallel_tool_use)"
  ),
  "system-prompt-placement": {
    sections: ring(S, "system prompt"),
    tag: "system prompt moved into a leading developer message (OpenAI) / sent as text blocks (Anthropic)",
  },
  "system-message-appended": {
    sections: [...S, added("system message", 12)],
    tag: "a system message appended after the final message (developer on OpenAI)",
  },
  "switch-model": param(
    "model: gpt-5.6-sol → gpt-5.6-luna, gpt-5.5 → gpt-5.4, claude-opus-5 → claude-sonnet-5"
  ),
  "change-effort": param(
    "reasoning effort: low → medium",
    "Every other pair of effort levels gives the same result."
  ),
  "omit-default-effort": param(
    "effort omitted, after request 1 set it to the default (medium on OpenAI, high on Anthropic)"
  ),
  "effort-switch-back": {
    before: [{ label: "request 2", sections: S, tag: "effort: low → medium" }],
    sections: S,
    tag: "effort: medium → low again",
  },
  "reasoning-summaries": param("reasoning summaries: off → on"),
  "disable-thinking": param("thinking: adaptive → disabled"),
  "per-message-effort": {
    sections: [...S, added("effort message", 8)],
    tag: "an effort-only system message appended (beta)",
    note: "Sending only the beta header, with no message, gives the same result.",
  },
  "max-output-tokens": param("max output tokens: 256 → 512"),
  "json-schema-output": param("output format: plain text → a JSON schema"),
  verbosity: param("text.verbosity: medium → high"),
  "stop-sequences": param("stop sequences: none → [“###”]"),
  "service-tier": param(
    "service tier: default → priority (OpenAI) / standard_only (Anthropic)"
  ),
  "cache-retention": param(
    "cache retention: in-memory → 24h (OpenAI) / 5 min → 1 h (Anthropic)"
  ),
  metadata: param("metadata: none → one key"),
  "end-user-id": param(
    "end-user id added (OpenAI safety_identifier, Anthropic metadata.user_id)"
  ),
  "cache-key": param("prompt_cache_key: this conversation’s key → another"),
  store: param("store: false → true"),
  truncation: param("truncation: disabled → auto"),
  "inference-geo": param("inference_geo: default → us"),
  "cache-mode-switch": param(
    "automatic caching → one explicit breakpoint on the final message"
  ),
};

const THREAD_DRAW: Record<string, Draw> = {
  next_turn: {
    sections: [
      ...upTo(T, "user 5"),
      { label: "reply 5", tokens: REPLY, added: true },
      { label: "user 6", tokens: USER, added: true },
    ],
    tag: "reply 5 and user message 6 appended, nothing else changed",
  },
  edit_u4: {
    sections: ring(T, "user 4"),
    tag: "one word appended to user message 4",
  },
  edit_a4: {
    sections: ring(T, "reply 4"),
    tag: "one word appended to reply 4",
  },
  branch_at_u4: {
    sections: [
      ...upTo(T, "reply 3"),
      { label: "user 4", tokens: USER, changed: true },
    ],
    tag: "user message 4 replaced, and the rest of the thread dropped",
  },
  truncate_after_a4: {
    sections: [
      ...upTo(T, "reply 4"),
      { label: "user 5", tokens: USER, changed: true },
    ],
    tag: "everything after reply 4 dropped, and a new message sent",
  },
};

/** The variant a static drawing shows for one adapter. */
function drawnVariant(row: Row, adapter: Column): string | null {
  const vs = row.variants?.[adapter];
  if (!vs) return null;
  if (vs[0] === EFFORT_PAIRS) {
    return adapter.startsWith("openai")
      ? "effort_medium"
      : "effort_low_to_medium";
  }
  return vs[0]!;
}

function billedFor(row: Row, adapter: Column): Billed {
  const cell = row.cells[adapter];
  if (cell.status === "n/a") return { kind: "text", text: "no such setting" };
  if (cell.status === "not tested") {
    return { kind: "text", text: "not tested" };
  }
  if (row.kind === "thread") {
    const t = cell.thread!;
    // Request-end matching lands on the end of the last intact user
    // message; gpt-5.5 stops at a token position (same prompt and
    // tokenizer as sol).
    if (Math.abs(t.cached - t.previousEnd) <= 8) {
      const k = row.probe === "next_turn" ? 5 : intactTurn(row.probe!);
      return { kind: "cached", tokens: endOf(T, `user ${k}`) };
    }
    return { kind: "cached", tokens: t.cached };
  }
  const variant = drawnVariant(row, adapter)!;
  const s = cell.summaries.find(
    (x) => x.variant === variant || aliasEffort(x.variant, adapter) === variant
  );
  if (!s || tier(s) === "rejected") {
    return { kind: "text", text: "rejected by the API" };
  }
  return { kind: "cached", tokens: toLayout(adapter, s.variant) };
}

/** Other variants in the row, when they give the same outcome everywhere. */
function sameAsNote(row: Row): string | undefined {
  const vs = row.variants?.openai_responses ?? row.variants?.anthropic_auto;
  if (!vs || vs.length < 2 || vs[0] === EFFORT_PAIRS) return undefined;
  const same = COLUMNS.every((c) => {
    const tiers = new Set(
      row.cells[c].summaries.map((s: VariantSummary) => tier(s))
    );
    return tiers.size <= 1;
  });
  if (!same) return undefined;
  const adapter = ADAPTERS.openai_responses!;
  const describe = (v: string) =>
    (adapter.variants.find((x) => x.name === v)?.description ?? v)
      .replace(/`/g, "")
      .replace(/\.$/, "")
      .replace(/^./, (c) => c.toLowerCase());
  return `The same result for: ${vs.slice(1).map(describe).join("; ")}.`;
}

const SHORT: Record<Column, string> = {
  openai_responses: "gpt-5.6-sol",
  "openai_responses_gpt-5.5": "gpt-5.5",
  anthropic_auto: "Claude automatic",
  anthropic_breakpoints: "Claude breakpoints",
};

/** A cell's outcome, shortened for a figure title. */
const titleText = (text: string) =>
  text
    .replace(
      /caches up to a fixed block point \((\d+) tokens[^)]*\)(, [^;]*)?/,
      "caches up to token $1"
    )
    .replace(/; reply \d+ onward re-billed/, "")
    .replace(/ \(\d+ tokens, of ~\d+ in the previous request\)/, "");

/**
 * The general outcome for the title, and the exceptions for the note: the
 * outcome most columns share, and each column that differs from it.
 */
function outcomes(row: Row): { general: string; exceptions: string[] } {
  const byText = new Map<string, Column[]>();
  const tested = COLUMNS.filter((c) => row.cells[c].status === "tested");
  for (const c of tested) {
    const t = titleText(row.cells[c].text);
    byText.set(t, [...(byText.get(t) ?? []), c]);
  }
  const groups = [...byText.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );
  const top = groups[0]!;
  const names = (cols: Column[]) => cols.map((c) => SHORT[c]).join(" and ");
  // General only when most of the columns tested agree, not a plurality.
  if (top[1].length > tested.length / 2) {
    return {
      general: top[0],
      exceptions: groups.slice(1).map(([t, cols]) => `${names(cols)}: ${t}.`),
    };
  }
  // A clean split between the two providers is general too.
  const byProvider = (p: string) => (cols: Column[]) =>
    cols.every((c) => c.startsWith(p));
  if (
    groups.length === 2 &&
    groups.some(([, cols]) => byProvider("openai")(cols)) &&
    groups.some(([, cols]) => byProvider("anthropic")(cols))
  ) {
    const openai = groups.find(([, cols]) => byProvider("openai")(cols))!;
    const anthropic = groups.find(([, cols]) => byProvider("anthropic")(cols))!;
    return {
      general: `${openai[0]} on OpenAI; ${anthropic[0]} on Anthropic`,
      exceptions: [],
    };
  }
  return {
    general: "where caching stops depends on the API",
    exceptions: groups.map(([t, cols]) => `${names(cols)}: ${t}.`),
  };
}

const plain = (s: string) => s.replace(/`/g, "");
/** Sentence case, except where the sentence starts with a model name. */
const capitalise = (s: string) =>
  /^gpt-/.test(s) ? s : s.replace(/^./, (c) => c.toUpperCase());

const comparison = buildComparison(allStatic, threadRows);
const CASES: Case[] = comparison.map((row) => {
  const draw = row.kind === "thread" ? THREAD_DRAW[row.probe!] : DRAW[row.id];
  if (!draw) throw new Error(`no drawing for ${row.id}`);
  const nextTurn = row.probe === "next_turn";
  const first: Request =
    row.kind === "thread"
      ? nextTurn
        ? { label: "request 5", sections: upTo(T, "user 5") }
        : { label: "request 6", sections: T }
      : { label: "request 1", sections: S };
  const lastLabel =
    row.kind === "thread"
      ? nextTurn
        ? "request 6"
        : "request 7"
      : `request ${2 + (draw.before?.length ?? 0)}`;
  const requests: Request[] = [
    first,
    ...(draw.before ?? []),
    { label: lastLabel, sections: draw.sections, tag: draw.tag },
  ];
  const billed = Object.fromEntries(
    COLUMNS.map((c) => [c, billedFor(row, c)])
  ) as Record<Column, Billed>;
  return {
    id: row.id,
    title: `${plain(row.text)}. ${capitalise(outcomes(row).general)}.`,
    alt: `${requests
      .map((r) => `${r.label}${r.tag ? ` (${plain(r.tag)})` : ""}`)
      .join(
        ", then "
      )}, drawn as rows of blocks for the tools, system prompt and messages. Below, one row per API for ${lastLabel}: ${COLUMNS.map(
      (c) => `${COLUMN_TITLES[c]}, ${row.cells[c].text}`
    ).join("; ")}.`,
    requests,
    billed,
    note:
      [...outcomes(row).exceptions, draw.note ?? sameAsNote(row)]
        .filter(Boolean)
        .join(" ") || undefined,
  };
});

const TABLE = comparison.map((row) => ({
  id: row.id,
  group: row.group,
  text: row.text,
  cells: Object.fromEntries(
    COLUMNS.map((c) => [
      c,
      {
        text: row.cells[c].text,
        status: row.cells[c].status,
        tier: row.cells[c].tier,
      },
    ])
  ),
}));

const ts = `// Generated by experiments/cache_breakers/scripts/export-blog-data.ts from
// the experiment's results CSVs. Do not edit by hand; re-run the script.

export type Column = ${COLUMNS.map((c) => JSON.stringify(c)).join(" | ")};

export const COLUMN_TITLES: Record<Column, string> = ${JSON.stringify(COLUMN_TITLES, null, 2)};

export type Section = {
  label: string;
  tokens: number;
  /** The part this request changed. */
  changed?: boolean;
  /** A part request 1 didn't have. */
  added?: boolean;
};

export type Request = { label: string; sections: Section[]; tag?: string };

export type Billed =
  | { kind: "cached"; tokens: number }
  | { kind: "text"; text: string };

export type Case = {
  id: string;
  title: string;
  alt: string;
  /** The requests in order; the last is the one billed below. */
  requests: Request[];
  /** Tokens of the last request read from cache, on the drawing's layout. */
  billed: Record<Column, Billed>;
  note?: string;
};

export type TableRow = {
  id: string;
  group: string;
  /** May contain \`code\` spans. */
  text: string;
  cells: Record<
    Column,
    { text: string; status: "tested" | "n/a" | "not tested"; tier: string | null }
  >;
};

export const CASES: Case[] = ${JSON.stringify(CASES, null, 2)};

export const TABLE: TableRow[] = ${JSON.stringify(TABLE, null, 2)};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ts);
console.log(`wrote ${OUT}: ${CASES.length} cases`);
