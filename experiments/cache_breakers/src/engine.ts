// A model of each API's prompt cache, so a thread of several changes can be
// predicted from rules the experiment measured one change at a time.
// scripts/run-sequences.ts checks its predictions against live threads.
//
// Every request leaves cache entries at fixed points in its prompt, each at
// the end of a part. A later request reads the furthest entry whose parts it
// repeats unchanged up to that point, written under settings compatible
// with its own. What differs per API is where the points are:
//
//   header  the end of the system prompt, and the end of every request
//           (gpt-5.6-sol, gpt-6-luna)
//   marks   the end of every part carrying a cache_control marker: the
//           tools, system prompt and last message with explicit
//           breakpoints, only the last part in automatic mode (Anthropic)
//
//   blocks  fixed token positions, reusable up to the tokens shared, even
//           partway into an edited part (gpt-5.5). Approximate: three of
//           the measured single changes read one block less (log.md,
//           2026-09-28).
//
// Self-contained on purpose: the blog export copies this file verbatim.

/** One part of a prompt: the tools, the system prompt, or one message. */
export interface Block {
  /** Identity of this exact content. */
  key: string;
  /** Identity of the part it is a version of; edits keep the stem. */
  stem: string;
  /** Leading tokens every version of the stem shares (blocks rule only). */
  kept?: number;
  tokens: number;
  label: string;
}

export type Params = Record<string, string>;

export interface Request {
  blocks: Block[];
  params: Params;
}

/**
 * What changing a setting does to the entries written before the change:
 * readable (keep), unreadable (drop), readable up to the end of a header
 * part (cut), or never measured (unknown).
 */
export type Effect =
  | { kind: "keep" }
  | { kind: "drop" }
  | { kind: "cut"; after: string }
  | { kind: "unknown" };

export interface ParamRule {
  initial: string;
  /** Values the API accepts; a value outside them leaves the request as it was. */
  values: string[];
  /** Measured effect per change, keyed `${from}>${to}`. */
  changes: Record<string, Effect>;
  /**
   * While the setting has this value, every read stops this many tokens
   * short (OpenAI tool_choice: required), whatever the value the entry was
   * written under.
   */
  tail?: { value: string; tokens: number };
}

export interface Rules {
  points: "header" | "marks" | "blocks";
  /** header: the stem whose end is the header point. */
  headerStem?: string;
  /** blocks: the first point and the spacing. */
  block?: { first: number; step: number };
  /** marks: the stems always marked, and whether the last block is. */
  marks?: { stems: string[]; last: boolean };
  /** Settings this API has; any other setting is ignored. */
  params: Record<string, ParamRule>;
  /**
   * Effort changes arrive as update parts in the prompt (GPT-6's
   * configuration_update), so the request-level effort never changes.
   */
  effortUpdates?: boolean;
}

export interface Outcome {
  total: number;
  cached: number;
  /** The request (0-based) whose entry was read, or null. */
  from: number | null;
  /** A setting changed in a way that was never measured. */
  unknown: boolean;
  /** Settings the reader changed that this API doesn't have. */
  ignored: string[];
}

interface Entry {
  request: number;
  at: number;
  blocks: Block[];
  params: Params;
}

const sum = (blocks: Block[]) => blocks.reduce((t, b) => t + b.tokens, 0);

/**
 * Tokens two prompts share from the start: whole unchanged parts, and with
 * `partial`, the leading tokens of the first part that differs.
 */
export function sharedPrefix(a: Block[], b: Block[], partial = false): number {
  let t = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key === y.key) {
      t += x.tokens;
      continue;
    }
    if (partial && x.stem === y.stem) {
      t += Math.min(x.kept ?? 0, y.kept ?? 0, x.tokens, y.tokens);
    }
    break;
  }
  return t;
}

/** End of the first block with this stem, or null. */
function endOf(blocks: Block[], stem: string): number | null {
  let t = 0;
  for (const b of blocks) {
    t += b.tokens;
    if (b.stem === stem) return t;
  }
  return null;
}

function points(rules: Rules, blocks: Block[]): number[] {
  const total = sum(blocks);
  if (rules.points === "blocks") {
    const { first, step } = rules.block!;
    const out: number[] = [];
    for (let p = first; p <= total; p += step) out.push(p);
    return out;
  }
  if (rules.points === "marks") {
    const { stems, last } = rules.marks!;
    const out: number[] = [];
    let t = 0;
    blocks.forEach((b, i) => {
      t += b.tokens;
      if (stems.includes(b.stem) || (last && i === blocks.length - 1)) {
        out.push(t);
      }
    });
    return out;
  }
  const header = endOf(blocks, rules.headerStem!);
  return [...(header !== null && header < total ? [header] : []), total];
}

export function effect(rule: ParamRule, from: string, to: string): Effect {
  if (from === to) return { kind: "keep" };
  return (
    rule.changes[`${from}>${to}`] ??
    // A change back is assumed to mirror the change out; the sequence
    // validation checks it.
    rule.changes[`${to}>${from}`] ?? { kind: "unknown" }
  );
}

/** The settings as this API would send them. */
function effective(
  rules: Rules,
  wanted: Params,
  previous: Params | null
): { params: Params; ignored: string[] } {
  const params: Params = {};
  const ignored: string[] = [];
  for (const [name, rule] of Object.entries(rules.params)) {
    const v =
      name === "effort" && rules.effortUpdates
        ? rule.initial
        : (wanted[name] ?? rule.initial);
    if (rule.values.includes(v)) params[name] = v;
    else {
      params[name] = previous?.[name] ?? rule.initial;
      ignored.push(name);
    }
  }
  for (const name of Object.keys(wanted)) {
    if (!(name in rules.params)) ignored.push(name);
  }
  return { params, ignored };
}

/** Predict what each request in order reads from the cache. */
export function simulate(rules: Rules, requests: Request[]): Outcome[] {
  const entries: Entry[] = [];
  const out: Outcome[] = [];
  let previous: Params | null = null;
  let wantedBefore: Params | null = null;
  requests.forEach((req, index) => {
    const { params, ignored } = effective(rules, req.params, previous);
    // Only report a setting as ignored on the request that changed it.
    const changed = ignored.filter(
      (n) => (req.params[n] ?? null) !== (wantedBefore?.[n] ?? null)
    );
    const total = sum(req.blocks);
    let best = 0;
    let from: number | null = null;
    let unknown = false;
    for (const e of entries) {
      let limit = e.at;
      let blocked = false;
      for (const [name, rule] of Object.entries(rules.params)) {
        const fx = effect(rule, e.params[name]!, params[name]!);
        if (fx.kind === "drop") blocked = true;
        else if (fx.kind === "unknown") {
          unknown = true;
          blocked = true;
        } else if (fx.kind === "cut") {
          const end = endOf(req.blocks, fx.after);
          limit = end === null ? 0 : Math.min(limit, end);
          if (e.at > limit) blocked = true;
        }
        if (rule.tail && params[name] === rule.tail.value) {
          limit = Math.min(limit, e.at - rule.tail.tokens);
        }
      }
      if (blocked || limit <= 0) continue;
      const shared = sharedPrefix(req.blocks, e.blocks, rules.points === "blocks");
      if (shared < e.at) continue;
      if (limit > best) {
        best = limit;
        from = e.request;
      }
    }
    out.push({ total, cached: best, from, unknown, ignored: changed });
    for (const at of points(rules, req.blocks)) {
      entries.push({ request: index, at, blocks: req.blocks, params });
    }
    previous = params;
    wantedBefore = req.params;
  });
  return out;
}

/** The outcome in words, named by the parts of the request. */
export function describe(o: Outcome, blocks: Block[]): string {
  if (o.unknown && o.cached === 0) return "not measured";
  if (o.cached === 0) return "nothing cached";
  if (o.cached >= o.total) return "fully cached";
  let t = 0;
  for (const b of blocks) {
    const start = t;
    t += b.tokens;
    if (o.cached === t) return `caches through ${b.label}`;
    if (o.cached < t && o.cached > start) {
      return o.cached - start > b.tokens / 2
        ? `caches all but the end of ${b.label}`
        : `caches ${o.cached} tokens, partway into ${b.label}`;
    }
  }
  return "fully cached";
}
