// The engine against every measured case the blog's tool can build: each
// thread probe, replayed on that trial's own token sizes, and each static
// edit and setting change, replayed on the API's measured layout. A
// prediction has to land on the measured read. gpt-5.5's rule is
// approximate: its misses are listed in GPT55_MISSES, and the test fails if
// that list stops being exactly right.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { median, toObs, type Obs } from "./analyze.js";
import { parseCsv } from "./csv.js";
import { simulate, type Block, type Request, type Rules } from "./engine.js";
import { buildRules, RULE_COLUMNS, SETTING_VARIANTS } from "./rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const csvs = (scenario: string) => {
  const dir = path.join(here, "../results", scenario);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .flatMap((f) => parseCsv(fs.readFileSync(path.join(dir, f), "utf8")));
};
const staticObs: Obs[] = csvs("static").map(toObs);
const RULES = buildRules(staticObs);
const G55 = "openai_responses_gpt-5.5";

/** Measured cases gpt-5.5's block rule gets wrong (each reads one block less). */
const GPT55_MISSES = [
  "edit_u4",
  "edit_u4_after_60s",
  "branch_at_u4",
  "early_edit_end",
  "late_edit_start",
];

/** A part; `kept` is how many leading tokens an edited version still shares. */
const block = (stem: string, tokens: number, version = 0, kept = tokens): Block => ({
  key: `${stem}@${version}`,
  stem,
  kept,
  tokens,
  label: stem,
});
/** The part with a word appended (end) or its first character changed (start). */
const edited = (b: Block, at: "start" | "end" = "end"): Block =>
  block(b.stem, b.tokens + 1, 1, at === "end" ? b.tokens : 0);

/** No misses, or for gpt-5.5 exactly the documented ones in this scope. */
function expectMisses(column: string, cases: string[], misses: string[]) {
  const expected =
    column === G55 ? GPT55_MISSES.filter((m) => cases.includes(m)) : [];
  expect([...new Set(misses)].sort()).toEqual([...expected].sort());
}

describe("thread probes, on each trial's token sizes", () => {
  const rows = csvs("thread").filter((r) => !r.error);
  // Every user message is ~150 words; its share of each turn's growth.
  const USER = 160;
  for (const column of RULE_COLUMNS) {
    it(column, () => {
      const mine = rows.filter((r) => r.provider === column);
      expect(mine.length).toBeGreaterThan(0);
      // Per probe, the predicted and measured reads of every trial.
      const byProbe = new Map<
        string,
        { predicted: number; observed: number; total: number }[]
      >();
      for (const r of mine) {
        const sizes = r.request_tokens!.split(";").map(Number);
        const header = sizes[0]! - USER;
        // Split the header like the fixture (tools and system the same size).
        const thread: Block[] = [
          block("tools", Math.floor(header / 2)),
          block("system", header - Math.floor(header / 2)),
          block("u1", USER),
        ];
        for (let k = 2; k <= sizes.length; k++) {
          const growth = sizes[k - 1]! - sizes[k - 2]!;
          thread.push(block(`r${k - 1}`, growth - USER), block(`u${k}`, USER));
        }
        const request = (k: number) => thread.slice(0, 3 + 2 * (k - 1));
        const full = request(sizes.length);
        const edit = (stem: string) =>
          full.map((b) => (b.stem === stem ? edited(b) : b));
        const probe =
          r.probe === "edit_a4"
            ? edit("r4")
            : r.probe === "branch_at_u4"
              ? [...full.slice(0, 8), block("u4.b", USER)]
              : r.probe === "truncate_after_a4"
                ? [...full.slice(0, 10), block("u5.b", 10)]
                : edit("u4");
        const reqs: Request[] = [
          ...sizes.map((_, i) => ({ blocks: request(i + 1), params: {} })),
          { blocks: probe, params: {} },
        ];
        const last = simulate(RULES[column]!, reqs).at(-1)!;
        const list = byProbe.get(r.probe!) ?? [];
        list.push({
          predicted: last.cached,
          observed: Number(r.probe_cached),
          total: last.total,
        });
        byProbe.set(r.probe!, list);
      }
      const misses: string[] = [];
      for (const [probe, trials] of byProbe) {
        // gpt-5.5 misses the cache entirely at random (~5%): leave those out.
        const real = trials.filter((t) => column !== G55 || t.observed > 0);
        const off = median(real.map((t) => Math.abs(t.predicted - t.observed)))!;
        const tolerance =
          column === G55 ? 0 : Math.max(16, real[0]!.total * 0.01);
        if (off > tolerance) misses.push(probe);
      }
      expectMisses(column, [...byProbe.keys()], misses);
    });
  }
});

describe("static edits and settings, on each API's measured layout", () => {
  const main = staticObs.filter((o) => o.section_words === 1500);
  const trials = (column: string, variant: string) =>
    main.filter(
      (o) => o.provider === column && o.variant === variant && !o.error
    );
  const med = (column: string, variant: string, field: "cached" | "base_cached") =>
    median(trials(column, variant).map((o) => o[field]!)) ?? 0;
  /** Median share of the warm base each trial's variant still read. */
  const keptShare = (column: string, variant: string) =>
    median(trials(column, variant).map((o) => o.cached! / o.base_cached!));
  /** Prompts vary a little per trial, so compare shares of the warm read. */
  const missed = (reads: { cached: number }[], observed: number) =>
    Math.abs(reads.at(-1)!.cached / reads[1]!.cached - observed) > 0.02;

  /** tools, system, u1, r1, u2, r2, final, sized from landmark reads. */
  function layout(column: string): Block[] {
    // Anthropic automatic has no landmarks of its own; it shares
    // breakpoints' prompt. gpt-5.5 shares sol's prompt and tokenizer.
    const src =
      column === "anthropic_auto"
        ? "anthropic_breakpoints"
        : column === G55
          ? "openai_responses"
          : column;
    const total = med(src, "control", "base_cached");
    const systemEnd = med(src, "early_edit_start", "cached");
    const toolsEnd = src.startsWith("anthropic")
      ? med(src, "system_edit_start", "cached")
      : Math.floor(systemEnd / 2);
    const prevEnd = med(
      src === "anthropic_breakpoints" ? "anthropic_auto" : src,
      "prev_turn_then_final_edit",
      "cached"
    );
    const msg = Math.round((prevEnd - systemEnd) / 3);
    const final = 8;
    return [
      block("tools", toolsEnd),
      block("system", systemEnd - toolsEnd),
      block("u1", msg),
      block("r1", msg),
      block("u2", msg),
      block("r2", total - systemEnd - 3 * msg - final),
      block("u3", final),
    ];
  }

  const editOf = (stem: string, at: "start" | "end") => (b: Block[]) => ({
    blocks: b.map((x) => (x.stem === stem ? edited(x, at) : x)),
  });
  const CASES: Record<
    string,
    (b: Block[]) => { pre?: Block[][]; blocks: Block[] }
  > = {
    control: (b) => ({ blocks: b }),
    tools_edit_start: editOf("tools", "start"),
    tools_edit_end: editOf("tools", "end"),
    system_edit_start: editOf("system", "start"),
    system_edit_end: editOf("system", "end"),
    early_edit_start: editOf("u1", "start"),
    early_edit_end: editOf("u1", "end"),
    late_edit_start: editOf("u2", "start"),
    late_edit_end: editOf("u2", "end"),
    final_edit: editOf("u3", "end"),
    prev_turn_then_final_edit: (b) => ({
      pre: [b.slice(0, 5)],
      ...editOf("u3", "end")(b),
    }),
    prev_turn_then_late_reply_edit: (b) => ({
      pre: [b.slice(0, 5)],
      ...editOf("r2", "end")(b),
    }),
    append_turn: (b) => ({ blocks: [...b, block("r3", 20), block("u4", 20)] }),
  };

  for (const column of RULE_COLUMNS) {
    // The static fixture marks tools, system and both replies.
    const rules: Rules =
      column === "anthropic_breakpoints"
        ? {
            ...RULES[column]!,
            marks: { stems: ["tools", "system", "r1", "r2"], last: false },
          }
        : RULES[column]!;
    const provider = column.startsWith("openai") ? "openai" : "anthropic";

    it(`${column}: edits`, () => {
      const base = layout(column);
      const misses: string[] = [];
      for (const [variant, make] of Object.entries(CASES)) {
        const { pre = [], blocks } = make(base);
        const reqs: Request[] = [base, base, ...pre, blocks].map((b) => ({
          blocks: b,
          params: {},
        }));
        const observed = keptShare(column, variant);
        if (observed !== null && missed(simulate(rules, reqs), observed)) {
          misses.push(variant);
        }
      }
      expectMisses(column, Object.keys(CASES), misses);
    });

    it(`${column}: settings`, () => {
      const base = layout(column);
      const changes: [string, string, string | undefined, string][] = [];
      for (const [name, values] of Object.entries(SETTING_VARIANTS[provider])) {
        for (const [value, variant] of Object.entries(values)) {
          if (rules.params[name]?.values.includes(value)) {
            changes.push([variant, name, undefined, value]);
          }
        }
      }
      const levels = rules.params.effort!.values;
      // GPT-6 changes effort only with update items (checked below).
      for (const from of rules.effortUpdates ? [] : levels) {
        for (const to of levels) {
          if (from !== to) {
            changes.push([`effort_${from}_to_${to}`, "effort", from, to]);
          }
        }
      }
      const misses: string[] = [];
      for (const [variant, name, from, to] of changes) {
        const observedVariant = trials(column, variant).length
          ? variant
          : variant === "effort_low_to_medium"
            ? "effort_medium"
            : variant === "effort_low_to_none"
              ? "effort_none"
              : variant;
        const observed = keptShare(column, observedVariant);
        if (observed === null) continue; // rejected by the API: never offered
        const start = from ? { [name]: from } : {};
        const reads = simulate(rules, [
          { blocks: base, params: start },
          { blocks: base, params: start },
          { blocks: base, params: { [name]: to } },
        ]);
        if (missed(reads, observed)) misses.push(variant);
      }
      // GPT-6: the same changes as a configuration_update item appended
      // after the last message, the request-level effort left as it was.
      if (rules.effortUpdates) {
        for (const from of levels) {
          for (const to of levels) {
            if (from === to) continue;
            const variant = `update_effort_${from}_to_${to}`;
            const observed = keptShare(column, variant);
            if (observed === null) continue;
            const start = { effort: from };
            const reads = simulate(rules, [
              { blocks: base, params: start },
              { blocks: base, params: start },
              { blocks: [...base, block("cfg", 0)], params: start },
            ]);
            if (missed(reads, observed)) misses.push(variant);
          }
        }
      }
      expectMisses(column, [], misses);
    });
  }
});
