// The cross-API comparison: one row per change (thread probes, then the
// concepts in src/concepts.ts), one cell per adapter. Shared by the
// experiment page (scripts/build-report.ts) and the blog export
// (scripts/export-blog-data.ts), so both say exactly the same thing.
import {
  median,
  summarise,
  tier,
  type Obs,
  type Tier,
  type VariantSummary,
} from "./analyze.js";
import { CONCEPTS, EFFORT_PAIRS } from "./concepts.js";

export const COLUMNS = [
  "openai_responses",
  "openai_responses_gpt-5.5",
  "anthropic_auto",
  "anthropic_breakpoints",
] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_TITLES: Record<Column, string> = {
  openai_responses: "OpenAI gpt-5.6-sol",
  "openai_responses_gpt-5.5": "OpenAI gpt-5.5",
  anthropic_auto: "Anthropic, automatic",
  anthropic_breakpoints: "Anthropic, breakpoints",
};

/** Section size used for the comparison (other sizes are size sweeps). */
export const MAIN_SIZE = 1500;

/**
 * Adapters whose cache stops at fixed token positions, not message
 * boundaries: where they stop depends on message sizes, so their cells
 * report the block point in tokens instead of naming a message.
 */
export const BLOCK_MATCHING = new Set<string>(["openai_responses_gpt-5.5"]);

export const THREAD_PROBES: { probe: string; id: string; text: string }[] = [
  {
    probe: "edit_u4",
    id: "thread-edit-user-message",
    text: "Append a word to user message 4 of 6",
  },
  {
    probe: "edit_a4",
    id: "thread-edit-reply",
    text: "Append a word to reply 4 of 5",
  },
  {
    probe: "branch_at_u4",
    id: "thread-branch",
    text: "Replace user message 4 with a different one (branch)",
  },
  {
    probe: "truncate_after_a4",
    id: "thread-cut",
    text: "Drop everything after reply 4 and ask something new",
  },
];

/** The last intact request (it ends with this user message) per probe. */
export const intactTurn = (probe: string) =>
  probe === "truncate_after_a4" || probe === "edit_a4" ? 4 : 3;

// On OpenAI, low→medium and low→none were run before the pair sweep, under
// these names.
const OPENAI_ALIASES: Record<string, string> = {
  effort_medium: "effort_low_to_medium",
  effort_none: "effort_low_to_none",
};
export const aliasEffort = (variant: string, adapter: string) =>
  adapter.startsWith("openai") ? (OPENAI_ALIASES[variant] ?? variant) : variant;

export type CellStatus = "tested" | "n/a" | "not tested";

export interface Cell {
  status: CellStatus;
  tier: Tier | "mixed" | null;
  text: string;
  /** Per-variant detail for a tooltip. */
  detail: string;
  /** The summaries behind the cell (static rows). */
  summaries: VariantSummary[];
  /** Thread rows: median cached tokens and the previous turn's cached end. */
  thread?: { cached: number; previousEnd: number; nextEnd: number };
}

export interface Row {
  id: string;
  kind: "thread" | "concept";
  group: string;
  /** Row name; may contain `code` spans. */
  text: string;
  /** The probe (thread) or the concept's variants per adapter. */
  probe?: string;
  variants?: Record<string, string[]>;
  cells: Record<Column, Cell>;
}

// --- naming what a partial hit kept -----------------------------------------

interface Landmark {
  at: number;
  kept: string;
  /** What lies between this point and the next one. */
  next: string;
}

/**
 * Points in the prompt a cached count can be named by, as fractions of the
 * warm prompt. Measured per adapter from the probes that stop exactly there;
 * where a point wasn't measured, the sections' roughly equal sizes stand in
 * (tools, system, early exchange, late exchange: about a quarter each).
 */
function landmarks(sums: VariantSummary[], adapter: string): Landmark[] {
  const at = (variant: string, fallback: number) => {
    const s = sums.find((x) => x.variant === variant);
    return s && s.usable && tier(s) === "fallback" ? s.keptFraction! : fallback;
  };
  const bp = adapter === "anthropic_breakpoints";
  return [
    { at: 0, kept: "nothing", next: "tools" },
    {
      at: bp ? at("system_edit_start", 0.25) : 0.25,
      kept: "tools",
      next: "system prompt",
    },
    {
      at: at("early_edit_start", 0.5),
      kept: "tools and system prompt",
      next: "first exchange",
    },
    {
      at: bp ? at("late_edit_start", 0.75) : 0.75,
      kept: "tools, system prompt and first exchange",
      next: "third message",
    },
    {
      at: at("prev_turn_then_final_edit", 0.875),
      kept: "all but the last reply and final message",
      next: "last reply",
    },
    { at: 1, kept: "everything", next: "" },
  ].sort((x, y) => x.at - y.at);
}

function keptText(frac: number, marks: Landmark[]): string {
  const hit = marks.find((m) => Math.abs(m.at - frac) <= 0.03);
  if (hit) return `caches ${hit.kept}`;
  const below = [...marks].reverse().find((m) => m.at < frac)!;
  return below.at === 0
    ? `caches part of the ${below.next}`
    : `caches ${below.kept} and part of the ${below.next}`;
}

const tokenRange = (xs: number[]) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
};

function staticCell(
  picked: VariantSummary[],
  marks: Landmark[],
  blocks: boolean
): Cell {
  const detail = picked
    .map((s) =>
      s.usable
        ? `${s.variant}: ${Math.round((s.keptFraction ?? 0) * 100)}% of the warm prompt still cached`
        : `${s.variant}: rejected (${s.firstError})`
    )
    .join("\n");
  const ran = picked.filter((s) => tier(s) !== "rejected");
  const base = { status: "tested" as const, detail, summaries: picked };
  if (ran.length === 0) {
    return { ...base, tier: "rejected", text: "rejected by the API" };
  }
  const tiers = [...new Set(ran.map(tier))];
  const partial = (xs: VariantSummary[]) =>
    blocks
      ? `caches up to a fixed block point (${tokenRange(xs.map((s) => s.medianCached!))} tokens)`
      : [...new Set(xs.map((s) => keptText(s.keptFraction ?? 0, marks)))].join(
          "; or "
        );
  const one = (t: Tier, xs: VariantSummary[]) =>
    t === "zero"
      ? "nothing cached"
      : t === "none"
        ? "fully cached"
        : t === "tail"
          ? "caches all but a small tail at the end"
          : partial(xs);
  if (tiers.length === 1) {
    return { ...base, tier: tiers[0]!, text: one(tiers[0]!, ran) };
  }
  return {
    ...base,
    tier: "mixed",
    text: ran.map((s) => `${s.variant}: ${one(tier(s), [s])}`).join("; "),
  };
}

// --- thread cells ----------------------------------------------------------

/**
 * Where one thread probe's reuse stopped, named by message. Request k is
 * u1, a1, …, uk, so its prompt size (minus the 3 tokens never cached) is
 * where user message k ends. Between the end of uk and the end of uk+1 lie
 * reply k (~500 words) then user message k+1 (~150 words).
 */
function threadStop(r: Record<string, string>): string {
  const c = Number(r.probe_cached);
  if (c === 0) return "nothing cached";
  const uEnd = r.request_tokens!.split(";").map((x) => Number(x) - 3);
  let k = 0;
  for (let i = 0; i < uEnd.length; i++) if (uEnd[i]! <= c + 8) k = i + 1;
  if (k === 0) return "caches part of the tools and system prompt";
  if (Math.abs(c - uEnd[k - 1]!) <= 8) {
    return `caches through user message ${k}; reply ${k} onward re-billed`;
  }
  const next = uEnd[k];
  const intoReply =
    next === undefined || c - uEnd[k - 1]! < 0.7 * (next - uEnd[k - 1]!);
  return intoReply
    ? `caches through user message ${k} and part of reply ${k}`
    : `caches through reply ${k} and part of user message ${k + 1}`;
}

/**
 * The plain next step: request 6 appends reply 5 and user message 6 to
 * request 5. Every thread trial sent it before its probe, so its cache read
 * is the baseline for a conversation that only grows.
 */
function nextTurnCell(rows: Record<string, string>[], adapter: string): Cell {
  const rs = rows.filter((r) => r.provider === adapter && !r.error);
  if (rs.length === 0) {
    return {
      status: "not tested",
      tier: null,
      text: "not tested",
      detail: "",
      summaries: [],
    };
  }
  const read = rs.map((r) => Number(r.request_cached!.split(";")[5]));
  const prevEnd = rs.map((r) => Number(r.request_tokens!.split(";")[4]) - 3);
  const cached = median(read)!;
  const previousEnd = median(prevEnd)!;
  const full = rs.filter(
    (r, i) => Math.abs(read[i]! - prevEnd[i]!) <= 8 && r
  ).length;
  const detail = `request 6 read ${cached} (median of ${rs.length}); request 5 was ${previousEnd}`;
  if (BLOCK_MATCHING.has(adapter)) {
    return {
      status: "tested",
      tier: "fallback",
      text: `caches up to a fixed block point (${cached} tokens, of ~${previousEnd} in the previous request)`,
      detail,
      summaries: [],
      thread: { cached, previousEnd, nextEnd: previousEnd },
    };
  }
  return {
    status: "tested",
    tier: full === rs.length ? "none" : "fallback",
    text:
      full === rs.length
        ? "caches all of the previous request"
        : `caches all of the previous request in ${full} of ${rs.length}`,
    detail,
    summaries: [],
    thread: { cached, previousEnd, nextEnd: previousEnd },
  };
}

function threadCell(
  rows: Record<string, string>[],
  adapter: string,
  probe: string
): Cell {
  const rs = rows.filter(
    (r) => r.provider === adapter && r.probe === probe && !r.error
  );
  if (rs.length === 0) {
    return {
      status: "not tested",
      tier: null,
      text: "not tested",
      detail: "",
      summaries: [],
    };
  }
  const hits = rs.filter((r) => Number(r.probe_cached) > 0);
  const cached = median(hits.map((r) => Number(r.probe_cached))) ?? 0;
  const previousEnd =
    median(hits.map((r) => Number(r.predict_request_end))) ?? 0;
  const nextEnd = median(hits.map((r) => Number(r.next_request_end))) ?? 0;
  const k = intactTurn(probe);
  const spread = rs
    .map((r) => r.probe_cached)
    .sort((a, b) => Number(a) - Number(b))
    .join(", ");
  if (BLOCK_MATCHING.has(adapter)) {
    const where =
      Math.abs(cached - previousEnd) <= 8
        ? "at the previous turn’s cached end"
        : cached < previousEnd
          ? "short of the previous turn"
          : "past the previous turn";
    // The appended-word probe leaves everything through user message 4
    // unchanged, and request 4's size says exactly where that ends.
    const unchanged =
      probe === "edit_u4"
        ? `, of ~${median(hits.map((r) => Number(r.request_tokens!.split(";")[3]) - 3))} unchanged`
        : "";
    return {
      status: "tested",
      tier: "fallback",
      text: `caches up to a fixed block point (${cached} tokens${unchanged}), ${where}`,
      detail: `cached per trial: ${spread}; request ${k}'s cached end: ${previousEnd}`,
      summaries: [],
      thread: { cached, previousEnd, nextEnd },
    };
  }
  const counts = new Map<string, number>();
  for (const l of rs.map(threadStop)) counts.set(l, (counts.get(l) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  return {
    status: "tested",
    tier: "fallback",
    text: sorted[0]![0],
    detail: sorted.map(([l, n]) => `${n} of ${rs.length}: ${l}`).join("\n"),
    summaries: [],
    thread: { cached, previousEnd, nextEnd },
  };
}

// --- the table ------------------------------------------------------------

export function buildComparison(
  staticObs: Obs[],
  threadRows: Record<string, string>[]
): Row[] {
  const main = staticObs.filter((o) => o.section_words === MAIN_SIZE);
  const sums = new Map(
    COLUMNS.map((c) => [c, summarise(main.filter((o) => o.provider === c))])
  );
  const marks = new Map(
    COLUMNS.map((c) => {
      // gpt-5.5 shares gpt-5.6-sol's prompt and tokenizer, but its blocks
      // never stop on a section boundary, so it borrows sol's boundaries.
      const source = c === "openai_responses_gpt-5.5" ? "openai_responses" : c;
      return [c, landmarks(sums.get(source)!, c)];
    })
  );

  const rows: Row[] = [
    {
      id: "thread-next-turn",
      kind: "thread",
      group: "thread",
      text: "Append the next turn (a conversation that only grows)",
      probe: "next_turn",
      cells: Object.fromEntries(
        COLUMNS.map((c) => [c, nextTurnCell(threadRows, c)])
      ) as Record<Column, Cell>,
    },
  ];
  rows.push(
    ...THREAD_PROBES.map(({ probe, id, text }) => ({
      id,
      kind: "thread" as const,
      group: "thread",
      text,
      probe,
      cells: Object.fromEntries(
        COLUMNS.map((c) => [c, threadCell(threadRows, c, probe)])
      ) as Record<Column, Cell>,
    }))
  );

  for (const k of CONCEPTS) {
    const cells = {} as Record<Column, Cell>;
    for (const c of COLUMNS) {
      const variants = k.variants[c];
      if (!variants) {
        cells[c] = {
          status: "n/a",
          tier: null,
          text: "n/a",
          detail: "the API has no such setting",
          summaries: [],
        };
        continue;
      }
      const all = sums.get(c)!;
      const picked =
        variants[0] === EFFORT_PAIRS
          ? all.filter((s) =>
              /^effort_[a-z]+_to_[a-z]+$/.test(aliasEffort(s.variant, c))
            )
          : all.filter((s) => variants.includes(s.variant));
      cells[c] =
        picked.length === 0
          ? {
              status: "not tested",
              tier: null,
              text: "not tested",
              detail: "",
              summaries: [],
            }
          : staticCell(picked, marks.get(c)!, BLOCK_MATCHING.has(c));
    }
    rows.push({
      id: k.id,
      kind: "concept",
      group: k.group,
      text: k.text,
      variants: k.variants,
      cells,
    });
  }
  return rows;
}
