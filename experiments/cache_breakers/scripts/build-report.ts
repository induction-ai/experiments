/**
 * Builds report.html from blog.md and results/*.csv. Never hand-edit the
 * output; re-run `pnpm report` after any change to the blog or the results.
 *
 * The blog marks where generated content goes with HTML comments, which
 * render as nothing in blog.md itself:
 *   <!-- report:tiers -->      every change, grouped by what it does to the cache
 *   <!-- report:layout -->     checkpoint map recovered from the static probes
 *   <!-- report:static -->     chart + table for results/static/*.csv
 *   <!-- report:compare-static:a+b -->  one bar chart, one series per adapter
 *   <!-- report:tool_loop -->  chart + table for results/tool_loop/*.csv
 *   <!-- report:sizes -->      header probes repeated at other section sizes
 *   <!-- report:minimum -->    hits and misses around the minimum cacheable size
 *   <!-- report:thread -->     mid-thread edits vs the previous turn's end
 *   <!-- report:sweep -->      one word replaced at 8 points inside a message
 *
 * Everything except report:sizes uses only trials at MAIN_SIZE section words.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import {
  boundaries,
  label,
  median,
  summarise,
  tier,
  TIERS,
  toObs,
  usable,
  type Boundary,
  type Obs,
  type Tier,
  type VariantSummary,
} from "../src/analyze.js";
import { CONCEPTS, EFFORT_PAIRS } from "../src/concepts.js";
import { parseCsv } from "../src/csv.js";
import { ANTHROPIC_EFFORTS } from "../src/providers/anthropic-messages.js";
import { ADAPTERS } from "../src/providers/index.js";
import { EFFORTS, SWEEP } from "../src/providers/openai-responses.js";
import type { Variant } from "../src/providers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** Every row of every adapter's CSV for one scenario. */
function loadRows(scenario: string): Record<string, string>[] {
  const dir = path.join(root, "results", scenario);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort()
    .flatMap((f) => parseCsv(fs.readFileSync(path.join(dir, f), "utf8")));
}

const load = (scenario: string): Obs[] => loadRows(scenario).map(toObs);

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const GROUP_ORDER = [
  "control",
  "probe",
  "tools",
  "system",
  "messages",
  "model",
  "reasoning",
  "output",
  "sampling",
  "routing",
  "loop",
];

const GROUP_TITLES: Record<string, string> = {
  control: "Control",
  probe: "Section probes",
  tools: "Tools",
  system: "System prompt placement",
  messages: "Messages",
  model: "Model",
  reasoning: "Reasoning",
  output: "Output shape",
  sampling: "Sampling",
  routing: "Routing and account fields",
  loop: "Replaying the tool call",
  sweep: "Position sweep",
};

/** Plain-language outcome for one variant, from its break point. */
function outcome(s: VariantSummary): string {
  if (s.usable === 0) return s.errors ? "rejected by the API" : "no data";
  if (s.breaksAt === "full") return "everything kept";
  if ((s.medianCached ?? 0) <= 16) return "nothing kept";
  const lost = Math.round(s.medianLost ?? 0);
  if (s.breaksAt.startsWith("within:") || s.breaksAt === "start") {
    return `lost the last ${lost} tokens`;
  }
  return `kept only what precedes ${s.breaksAt.replace(/\//g, ", ")}`;
}

function sortSummaries(xs: VariantSummary[], order: string[]) {
  return [...xs].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      order.indexOf(a.variant) - order.indexOf(b.variant)
  );
}

function variantOrder(obs: Obs[]): string[] {
  const seen: string[] = [];
  for (const o of obs) if (!seen.includes(o.variant)) seen.push(o.variant);
  return seen;
}

function barChart(
  id: string,
  title: string,
  summaries: VariantSummary[],
  markers: { at: number; text: string }[]
): string {
  const rows = summaries
    .map((s, i) => {
      const heading =
        s.group !== summaries[i - 1]?.group
          ? `<div class="bar-group">${esc(GROUP_TITLES[s.group] ?? s.group)}</div>`
          : "";
      const pct = s.keptFraction === null ? 0 : s.keptFraction * 100;
      const tip = [
        `<strong>${esc(s.variant)}</strong>`,
        `${outcome(s)}`,
        s.usable
          ? `median cached ${s.medianCached} of ${s.medianBaseCached} (lost ${Math.round(s.medianLost ?? 0)})`
          : esc(s.firstError),
        `n = ${s.usable} usable of ${s.trials}` +
          (s.agreement !== null && s.usable
            ? `, ${Math.round(s.agreement * 100)}% agree`
            : ""),
      ].join("<br>");
      const value = s.usable
        ? `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%`
        : "n/a";
      return `${heading}<div class="bar-row" tabindex="0" data-tip="${esc(tip)}">
  <div class="bar-label"><code>${esc(s.variant)}</code></div>
  <div class="bar-track">${
    s.usable
      ? `<div class="bar-fill" style="width:${pct.toFixed(2)}%"></div>`
      : `<div class="bar-none">${esc(outcome(s))}</div>`
  }${markers
    .map(
      (m) =>
        `<div class="bar-marker" style="left:${(m.at * 100).toFixed(2)}%"></div>`
    )
    .join("")}</div>
  <div class="bar-value">${value}${s.usable && s.usable !== 5 ? `<span class="bar-n">n=${s.usable}</span>` : ""}</div>
</div>`;
    })
    .join("\n");
  const legend = markers.length
    ? `<p class="chart-note">Dashed line${markers.length > 1 ? "s" : ""}: ${markers
        .map((m) => esc(m.text))
        .join("; ")}.</p>`
    : "";
  return `<figure class="chart" id="${id}">
<figcaption>${esc(title)}</figcaption>
<div class="bar-axis"><span></span><span class="axis-scale"><span>0%</span><span>50%</span><span>100%</span></span><span></span></div>
${rows}
${legend}
</figure>`;
}

interface Series {
  label: string;
  summaries: VariantSummary[];
}

/**
 * Horizontal bars with one thin bar per series for each change, so two
 * models can be read against each other row by row. Series colours are the
 * first categorical slots, in fixed order.
 */
function multiBarChart(id: string, title: string, series: Series[]): string {
  const first = series[0]!.summaries;
  const names = first
    .map((s) => s.variant)
    .concat(
      series
        .slice(1)
        .flatMap((x) => x.summaries.map((s) => s.variant))
        .filter((v) => !first.some((s) => s.variant === v))
    )
    .filter((v) =>
      series.every((x) => x.summaries.some((s) => s.variant === v))
    );
  const find = (x: Series, v: string) =>
    x.summaries.find((s) => s.variant === v)!;
  const pct = (s: VariantSummary) =>
    s.keptFraction === null ? null : s.keptFraction * 100;
  const rows = names
    .map((v, i) => {
      const group = find(series[0]!, v).group;
      const heading =
        i === 0 || find(series[0]!, names[i - 1]!).group !== group
          ? `<div class="bar-group">${esc(GROUP_TITLES[group] ?? group)}</div>`
          : "";
      const tip = [
        `<strong>${esc(v)}</strong>`,
        ...series.map((x) => {
          const s = find(x, v);
          const p = pct(s);
          return `${esc(x.label)}: ${
            s.usable
              ? `${p!.toFixed(0)}% kept (${outcome(s)}), n=${s.usable}`
              : esc(`rejected: ${s.firstError}`)
          }`;
        }),
      ].join("<br>");
      const bars = series
        .map((x, k) => {
          const s = find(x, v);
          const p = pct(s);
          return s.usable
            ? `<div class="mbar s${k + 1}" style="width:${p!.toFixed(2)}%"></div>`
            : `<div class="mbar-none">rejected</div>`;
        })
        .join("");
      const values = series
        .map((x) => {
          const s = find(x, v);
          const p = pct(s);
          return s.usable ? `${p!.toFixed(0)}%` : "n/a";
        })
        .join(" · ");
      return `${heading}<div class="bar-row" tabindex="0" data-tip="${esc(tip)}">
  <div class="bar-label"><code>${esc(v)}</code></div>
  <div class="bar-track mtrack">${bars}</div>
  <div class="bar-value">${values}</div>
</div>`;
    })
    .join("\n");
  const legend = series
    .map(
      (x, k) =>
        `<span class="legend-item"><span class="swatch s${k + 1}"></span>${esc(x.label)}</span>`
    )
    .join("");
  return `<figure class="chart" id="${id}">
<figcaption>${esc(title)}</figcaption>
<div class="legend">${legend}</div>
<div class="bar-axis"><span></span><span class="axis-scale"><span>0%</span><span>50%</span><span>100%</span></span><span></span></div>
${rows}
</figure>`;
}

function table(summaries: VariantSummary[]): string {
  const head = [
    "variant",
    "group",
    "n",
    "median cached / warm base",
    "lost",
    "kept",
    "outcome",
    "agree",
  ];
  const body = summaries
    .map((s) => {
      const cells = [
        `<code>${esc(s.variant)}</code>`,
        esc(s.group),
        `${s.usable}/${s.trials}`,
        s.usable ? `${s.medianCached} / ${s.medianBaseCached}` : "n/a",
        s.usable ? String(Math.round(s.medianLost ?? 0)) : "n/a",
        s.keptFraction === null
          ? "n/a"
          : `${(s.keptFraction * 100).toFixed(1)}%`,
        s.usable ? esc(outcome(s)) : esc(`rejected: ${s.firstError}`),
        s.agreement === null ? "n/a" : `${Math.round(s.agreement * 100)}%`,
      ];
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    })
    .join("\n");
  return `<details class="table-view"><summary>Table view (all variants)</summary>
<div class="table-scroll"><table><thead><tr>${head
    .map((h) => `<th>${h}</th>`)
    .join("")}</tr></thead><tbody>
${body}
</tbody></table></div></details>`;
}

const SIZE_PROBES = [
  "control",
  "early_edit_start",
  "tools_edit_start",
  "tools_edit_end",
  "system_edit_start",
  "system_edit_end",
];

/** The header probes at every section size tested, one column per size. */
function sizesTable(obs: Obs[]): string {
  const sizes = [...new Set(obs.map((o) => o.section_words))].sort(
    (a, b) => a - b
  );
  if (sizes.length < 2) return "";
  const bySize = new Map(
    sizes.map((z) => [
      z,
      new Map(
        summarise(obs.filter((o) => o.section_words === z)).map((s) => [
          s.variant,
          s,
        ])
      ),
    ])
  );
  const cell = (s: VariantSummary | undefined) =>
    !s || s.usable === 0
      ? "n/a"
      : `${s.medianCached} / ${s.medianBaseCached}<span class="var-name">n=${s.usable}</span>`;
  const head = sizes
    .map((z) => `<th class="num">${z} words/section</th>`)
    .join("");
  const body = SIZE_PROBES.map(
    (v) =>
      `<tr><td><code>${esc(v)}</code></td>${sizes
        .map((z) => `<td class="num">${cell(bySize.get(z)!.get(v))}</td>`)
        .join("")}</tr>`
  ).join("\n");
  return `<figure class="chart"><figcaption>Median cached tokens / warm base, by section size</figcaption>
<div class="table-scroll"><table><thead><tr><th>probe</th>${head}</tr></thead><tbody>
${body}
</tbody></table></div></figure>`;
}

interface MinPoint {
  probe: string;
  tokens: number;
  hit: boolean;
  words: string;
}

/**
 * Cacheable tokens per minimum probe: input minus the 3 never-cached tokens
 * for `whole`; the header itself for `header` (the header-only request minus
 * its fixed overhead, measured from the hits as size_tokens − cached).
 */
function minimumPoints(rows: Record<string, string>[]): MinPoint[] {
  const ok = rows.filter((r) => !r.error && r.size_tokens && r.cached !== "");
  const overhead = median(
    ok
      .filter((r) => r.probe === "header" && Number(r.cached) > 0)
      .map((r) => Number(r.size_tokens) - Number(r.cached))
  );
  return ok.map((r) => ({
    probe: r.probe!,
    tokens:
      r.probe === "whole"
        ? Number(r.size_tokens) - 3
        : Number(r.size_tokens) - (overhead ?? 0),
    hit: Number(r.cached) > 0,
    words: r.words!,
  }));
}

function minimumChart(points: MinPoint[]): string {
  if (points.length === 0) return "";
  const lo = 990;
  const hi = 1060;
  const near = points.filter((p) => p.tokens >= lo && p.tokens <= hi);
  const x = (t: number) => ((t - lo) / (hi - lo)) * 100;
  const rows = ["whole", "header"]
    .map((probe) => {
      const ps = near.filter((p) => p.probe === probe);
      const misses = points.filter((p) => p.probe === probe && !p.hit);
      const hits = points.filter((p) => p.probe === probe && p.hit);
      const maxMiss = Math.max(...misses.map((p) => p.tokens));
      const minHit = Math.min(...hits.map((p) => p.tokens));
      const dots = ps
        .map(
          (p) =>
            `<span class="min-dot ${p.hit ? "hit" : "miss"}" style="left:${x(p.tokens).toFixed(2)}%" tabindex="0" data-tip="${esc(
              `<strong>${probe}</strong><br>${Math.round(p.tokens)} cacheable tokens (${p.words} words)<br>${p.hit ? "cached" : "not cached"}`
            )}"></span>`
        )
        .join("");
      const title = probe === "whole" ? "Whole prompt" : "Header checkpoint";
      return `<div class="min-row"><div class="bar-label">${title}<span class="var-name">largest miss ${Math.round(maxMiss)}, smallest hit ${Math.round(minHit)}</span></div><div class="min-track">${dots}<span class="min-rule" style="left:${x(1024).toFixed(2)}%"></span></div></div>`;
    })
    .join("\n");
  const ticks = [1000, 1024, 1050]
    .map((t) => `<span style="left:${x(t).toFixed(2)}%">${t}</span>`)
    .join("");
  return `<figure class="chart"><figcaption>Cached or not, by cacheable tokens (${points.length} trials, ${near.length} shown between ${lo} and ${hi})</figcaption>
${rows}
<div class="min-row"><span></span><div class="min-ticks">${ticks}</div></div>
<p class="chart-note">Filled dot: cached on repeat. Hollow ring: never cached. Dashed line: 1024 tokens.</p>
</figure>`;
}

/** Cached tokens when one word changes at 8 points inside a long message. */
function sweepTable(obs: Obs[]): string {
  const ok = usable(obs.filter((o) => o.group === "sweep"));
  if (ok.length === 0) return "";
  const at = (where: string, pct: number) =>
    ok
      .filter((o) => o.variant === `sweep_${where}_${pct}`)
      .map((o) => o.cached!)
      .sort((a, b) => a - b);
  const cell = (xs: number[]) =>
    xs.length
      ? `${median(xs)}<span class="var-name">${xs.join(", ")}</span>`
      : "n/a";
  const body = SWEEP.map((f) => Math.round(f * 1000) / 10)
    .map(
      (pct) =>
        `<tr><td class="num">${pct}%</td><td class="num">${cell(at("system", pct))}</td><td class="num">${cell(at("early", pct))}</td></tr>`
    )
    .join("\n");
  const base = median(
    usable(obs.filter((o) => o.variant === "control")).map(
      (o) => o.base_cached!
    )
  );
  return `<figure class="chart"><figcaption>One word replaced partway through a message: cached tokens (median, then every trial)</figcaption>
<div class="table-scroll"><table><thead><tr><th class="num">position in the message</th><th class="num">in <code>instructions</code></th><th class="num">in history message 1</th></tr></thead><tbody>
${body}
</tbody></table></div>
<p class="chart-note">The warm prompt had ${base} cached tokens. Fixed-size block matching makes the count step up as the edit moves later; message-level matching keeps it flat.</p>
</figure>`;
}

const THREAD_TEXT: Record<string, string> = {
  edit_u4: "Edit user message 4 of 6",
  branch_at_u4: "Branch at turn 4 with a different message",
  truncate_after_a4: "Cut after reply 4 and ask something new",
  edit_u4_after_60s: "Edit user message 4, after a 60 s pause",
};

/** Thread probes: where reuse stopped, against the previous turn's end. */
function threadTable(rows: Record<string, string>[]): string {
  const ok = rows.filter((r) => !r.error && r.probe_cached !== "");
  if (ok.length === 0) return "";
  const probes = [...new Set(ok.map((r) => r.probe!))];
  const body = probes
    .map((p) => {
      const rs = ok.filter((r) => r.probe === p);
      const n = (k: string) => rs.map((r) => Number(r[k]));
      const exact = rs.filter(
        (r) =>
          Math.abs(Number(r.probe_cached) - Number(r.predict_request_end)) <= 8
      ).length;
      const errs = rows.filter((r) => r.probe === p && r.error).length;
      return `<tr><td>${esc(THREAD_TEXT[p] ?? p)}<span class="var-name">${esc(p)}</span></td><td class="num">${median(n("probe_cached"))}</td><td class="num">${median(n("predict_request_end"))}</td><td class="num">${median(n("next_request_end"))}</td><td class="num">${exact} of ${rs.length}${errs ? ` (${errs} failed)` : ""}</td></tr>`;
    })
    .join("\n");
  return `<figure class="chart"><figcaption>Real 6-turn thread: where reuse stops after a mid-thread change (median tokens)</figcaption>
<div class="table-scroll"><table><thead><tr><th>Change</th><th class="num">cached</th><th class="num">end of previous turn</th><th class="num">end of the turn after</th><th class="num">exactly at previous turn</th></tr></thead><tbody>
${body}
</tbody></table></div>
<p class="chart-note">“End of previous turn” is what the next turn read when the thread grew normally. A longest-prefix rule would reach into the unchanged assistant reply, towards “end of the turn after”.</p>
</figure>`;
}

function layout(bounds: Boundary[], total: number, model: string): string {
  if (bounds.length === 0 || total <= 0) return "";
  const names: Record<string, string> = {
    tools: "tools",
    system: "instructions",
    early: "history",
    late: "history",
    final: "final message",
  };
  const segs = bounds.map((b, i) => {
    const end = bounds[i + 1]?.start ?? total;
    const parts = [...new Set(b.sections.map((s) => names[s]))];
    return { from: b.start, to: end, text: parts.join(" + ") };
  });
  return `<figure class="chart layout" aria-label="Cache checkpoints for ${esc(model)}">
<figcaption>Cache checkpoints, ${esc(model)} (median token offsets from the start probes)</figcaption>
<div class="layout-strip">${segs
    .map(
      (s) =>
        `<div class="layout-seg" style="flex:${Math.max(s.to - s.from, 1)}"><span>${esc(
          s.text
        )}</span><small>${Math.round(s.from)}–${Math.round(s.to)}</small></div>`
    )
    .join("")}</div>
<p class="chart-note">Each block is reused whole or not at all: an edit anywhere inside a block keeps only the blocks before it. The end of an earlier request that the new one fully contains is also reusable (section 1 below).</p>
</figure>`;
}

const TIER_TEXT: Record<Tier, { title: string; meaning: string }> = {
  zero: {
    title: "Resets the cache to zero",
    meaning: "Nothing is reused. The whole prompt is billed and written again.",
  },
  fallback: {
    title: "Falls back to an earlier point",
    meaning:
      "Reuse stops at the last checkpoint before the change (the header, or the end of an earlier request); everything after it is written again.",
  },
  tail: {
    title: "Costs a small uncached tail",
    meaning:
      "Everything is reused except a fixed number of tokens at the very end, which are billed uncached. Nothing is written or invalidated.",
  },
  none: {
    title: "No effect",
    meaning: "Everything is reused, exactly as if nothing had changed.",
  },
  rejected: {
    title: "Rejected by the API",
    meaning: "The request fails, so it can’t affect the cache.",
  },
};

/** Render a variant description's `code` spans as HTML. */
const inline = (s: string) =>
  esc(s).replace(/`([^`]+)`/g, (_, c: string) => `<code>${c}</code>`);

interface TierRow {
  area: string;
  order: number;
  text: string;
  n: number;
  kept: number | null;
}

// On OpenAI, low→medium and low→none were run before the pair sweep, under
// these names.
const OPENAI_ALIASES = {
  effort_medium: "effort_low_to_medium",
  effort_none: "effort_low_to_none",
};
const EFFORT_ALIASES: Record<string, Record<string, string>> = {
  openai_responses: OPENAI_ALIASES,
  "openai_responses_gpt-5.5": OPENAI_ALIASES,
};
const aliasEffort = (variant: string, adapterName: string) =>
  EFFORT_ALIASES[adapterName]?.[variant] ?? variant;

const EFFORT_LEVELS: Record<string, string[]> = {
  openai_responses: EFFORTS,
  "openai_responses_gpt-5.5": EFFORTS,
  anthropic_auto: ANTHROPIC_EFFORTS,
  anthropic_breakpoints: ANTHROPIC_EFFORTS,
};

/**
 * One row per variant, except that reasoning-effort pairs and "omitted"
 * variants landing in the same tier collapse into one row each.
 */
function tierRows(
  sums: VariantSummary[],
  variants: Variant[],
  scenario: "static" | "tool_loop",
  adapterName: string
): Map<Tier, TierRow[]> {
  const area = (group: string) =>
    scenario === "tool_loop"
      ? "Tool loop"
      : group === "probe"
        ? "Section edits"
        : (GROUP_TITLES[group] ?? group);
  const order = (group: string) =>
    (scenario === "tool_loop" ? 100 : 0) + GROUP_ORDER.indexOf(group);
  const levels = EFFORT_LEVELS[adapterName] ?? [];
  const byName = new Map(variants.map((v) => [v.name, v]));
  const out = new Map<Tier, TierRow[]>(TIERS.map((t) => [t, []]));
  const pairs = new Map<Tier, VariantSummary[]>();
  const omitted = new Map<Tier, VariantSummary[]>();
  for (const s of sums) {
    if (s.group === "sweep") continue;
    const t = tier(s);
    const name =
      scenario === "static" ? aliasEffort(s.variant, adapterName) : s.variant;
    if (scenario === "static" && /^effort_[a-z]+_to_[a-z]+$/.test(name)) {
      pairs.set(t, [...(pairs.get(t) ?? []), s]);
      continue;
    }
    if (scenario === "static" && /^effort_[a-z]+_omitted$/.test(name)) {
      omitted.set(t, [...(omitted.get(t) ?? []), s]);
      continue;
    }
    const text =
      t === "rejected"
        ? `${byName.get(s.variant)?.description ?? s.variant} (${s.firstError})`
        : (byName.get(s.variant)?.description ?? s.variant);
    out.get(t)!.push({
      area: area(s.group),
      order: order(s.group),
      text: `${inline(text)} <span class="var-name">${esc(s.variant)}</span>`,
      n: s.usable,
      kept: s.keptFraction,
    });
  }
  const minKept = (xs: VariantSummary[]) =>
    Math.min(...xs.map((x) => x.keptFraction ?? 0));
  for (const [t, xs] of pairs) {
    const total = [...pairs.values()].reduce((a, b) => a + b.length, 0);
    out.get(t)!.push({
      area: area("reasoning"),
      order: order("reasoning"),
      text: `Change <code>reasoning.effort</code> from one level to another (${xs.length} of ${total} ordered pairs of ${levels.join(", ")})`,
      n: xs.reduce((a, x) => a + x.usable, 0),
      kept: minKept(xs),
    });
  }
  for (const [t, xs] of omitted) {
    const levels = xs.map((x) => x.variant.split("_")[1]);
    out.get(t)!.push({
      area: area("reasoning"),
      order: order("reasoning"),
      text: `Omit <code>reasoning</code> after warming at ${levels
        .map((l) => `<code>${esc(l!)}</code>`)
        .join(", ")}`,
      n: xs.reduce((a, x) => a + x.usable, 0),
      kept: minKept(xs),
    });
  }
  return out;
}

function tiersBlock(parts: Map<Tier, TierRow[]>[]): string {
  return TIERS.map((t) => {
    const rows = parts
      .flatMap((p) => p.get(t) ?? [])
      .sort((a, b) => a.order - b.order);
    if (rows.length === 0) return "";
    const body = rows
      .map(
        (r) =>
          `<tr><td class="area">${esc(r.area)}</td><td>${r.text}</td><td class="num">${
            r.kept === null ? "n/a" : `${(r.kept * 100).toFixed(0)}%`
          }</td></tr>`
      )
      .join("\n");
    return `<section class="tier tier-${t}">
<h3>${esc(TIER_TEXT[t].title)} <span class="tier-count">${rows.length}</span></h3>
<p class="chart-note">${esc(TIER_TEXT[t].meaning)}</p>
<div class="table-scroll"><table><thead><tr><th>Area</th><th>Change</th><th class="num">kept</th></tr></thead><tbody>
${body}
</tbody></table></div>
</section>`;
  }).join("\n");
}

// ---------------------------------------------------------------------------

const MAIN_SIZE = 1500;
const allStatic = load("static");
const allLoop = load("tool_loop");
const minRows = loadRows("minimum");
const threadRows = loadRows("thread");
const main = (o: Obs) => o.section_words === MAIN_SIZE;

/** Everything the report says about one adapter (one API and cache mode). */
function adapterBlocks(name: string) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`report: unknown adapter ${name}`);
  const sObs = allStatic.filter((o) => o.provider === name && main(o));
  const lObs = allLoop.filter((o) => o.provider === name && main(o));
  const sSum = sortSummaries(summarise(sObs), variantOrder(sObs));
  const lSum = sortSummaries(summarise(lObs), variantOrder(lObs));
  const models = [...new Set(sObs.map((o) => o.model))].join(", ");
  const bounds = boundaries(sObs);
  const total =
    sSum.find((s) => s.variant === "control")?.medianBaseCached ?? 0;
  const markers =
    bounds.length > 1 && total
      ? bounds.slice(1).map((b, i) => ({
          at: b.start / total,
          text: `end of ${label(bounds[i]!).replace("system", "system prompt")}`,
        }))
      : [];
  return {
    tiers: () =>
      tiersBlock([
        tierRows(summarise(sObs), adapter.variants, "static", name),
        tierRows(
          summarise(lObs),
          adapter.toolLoop?.variants ?? [],
          "tool_loop",
          name
        ),
      ]),
    static: () =>
      barChart(
        `static-${name}`,
        `Share of the warm prompt still cached after one change (${name}, ${models}, median over trials)`,
        sSum,
        markers
      ) + table(sSum),
    tool_loop: () =>
      lSum.length
        ? barChart(
            `loop-${name}`,
            `Tool loop (${name}): share of the warm prompt still cached after one change`,
            lSum,
            []
          ) + table(lSum)
        : "",
    layout: () => layout(bounds, total, `${name}, ${models}`),
    sizes: () => sizesTable(allStatic.filter((o) => o.provider === name)),
    minimum: () =>
      minimumChart(minimumPoints(minRows.filter((r) => r.provider === name))),
    thread: () => threadTable(threadRows.filter((r) => r.provider === name)),
    sweep: () => sweepTable(sObs),
  };
}

const COMPARE_GROUP_TITLES: Record<string, string> = {
  probe:
    "Edits in a single request whose history was never sent turn by turn (the worst case)",
};

const COLUMN_TITLES: Record<string, string> = {
  openai_responses: "OpenAI gpt-5.6-sol",
  "openai_responses_gpt-5.5": "OpenAI gpt-5.5",
  anthropic_auto: "Anthropic, automatic",
  anthropic_breakpoints: "Anthropic, breakpoints",
};

/**
 * Points in the prompt a cached count can be named by, as fractions of the
 * warm prompt. Measured per adapter from the probes that stop exactly there;
 * where a point wasn't measured, the sections' roughly equal sizes stand in
 * (tools, system, early exchange, late exchange: about a quarter each).
 */
interface Landmark {
  at: number;
  kept: string;
  /** What lies between this point and the next one. */
  next: string;
}

function landmarks(name: string): Landmark[] {
  // gpt-5.5 shares gpt-5.6-sol's prompt and tokenizer, but its blocks never
  // stop on a section boundary, so it borrows sol's measured boundaries.
  const source =
    name === "openai_responses_gpt-5.5" ? "openai_responses" : name;
  const sum = summarise(
    allStatic.filter((o) => o.provider === source && main(o))
  );
  const at = (variant: string, fallback: number) => {
    const s = sum.find((x) => x.variant === variant);
    return s && s.usable && tier(s) === "fallback" ? s.keptFraction! : fallback;
  };
  const bp = name === "anthropic_breakpoints";
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

/** Name what a cached fraction kept, in terms of the prompt's sections. */
function keptText(frac: number, marks: Landmark[]): string {
  const hit = marks.find((m) => Math.abs(m.at - frac) <= 0.03);
  if (hit) return `caches ${hit.kept}`;
  const below = [...marks].reverse().find((m) => m.at < frac)!;
  return below.at === 0
    ? `caches part of the ${below.next}`
    : `caches ${below.kept} and part of the ${below.next}`;
}

/** A cell's text: the outcome, and for a partial one, what was kept. */
function cellText(
  sums: VariantSummary[],
  marks: Landmark[]
): { tier: Tier | "mixed"; text: string; detail: string } {
  const detail = sums
    .map((s) =>
      s.usable
        ? `${s.variant}: ${Math.round((s.keptFraction ?? 0) * 100)}% of the warm prompt still cached`
        : `${s.variant}: rejected (${s.firstError})`
    )
    .join("\n");
  const ran = sums.filter((s) => tier(s) !== "rejected");
  if (ran.length === 0)
    return { tier: "rejected", text: "rejected by the API", detail };
  const tiers = [...new Set(ran.map(tier))];
  const partial = (xs: VariantSummary[]) =>
    [...new Set(xs.map((s) => keptText(s.keptFraction ?? 0, marks)))].join(
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
  if (tiers.length === 1)
    return { tier: tiers[0]!, text: one(tiers[0]!, ran), detail };
  return {
    tier: "mixed",
    text: ran.map((s) => `${s.variant}: ${one(tier(s), [s])}`).join("; "),
    detail,
  };
}

const THREAD_COMPARE: Record<string, string> = {
  edit_u4: "Append a word to user message 4 of 6",
  branch_at_u4: "Replace user message 4 with a different one (branch)",
  truncate_after_a4: "Drop everything after reply 4 and ask something new",
};

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

/** Thread cell: the most common stopping point across trials. */
function threadCell(name: string, probe: string): string {
  const rs = threadRows.filter(
    (r) => r.provider === name && r.probe === probe && !r.error
  );
  if (rs.length === 0) return `<td class="cmp na">not tested</td>`;
  const labels = rs.map(threadStop);
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const top = sorted[0]![0];
  const title = sorted.map(([l, n]) => `${n} of ${rs.length}: ${l}`).join("\n");
  return `<td class="cmp cmp-fallback" title="${esc(title)}">${esc(top)}</td>`;
}

/** One row per concept, one column per adapter. */
function compareTable(names: string[]): string {
  const cols = names.filter((n) =>
    allStatic.some((o) => o.provider === n && main(o))
  );
  if (cols.length < 2) return "";
  const sums = new Map(
    cols.map((c) => [
      c,
      summarise(allStatic.filter((o) => o.provider === c && main(o))),
    ])
  );
  const marks = new Map(cols.map((c) => [c, landmarks(c)]));
  const cell = (c: string, variants: string[] | undefined): string => {
    if (!variants) return `<td class="cmp na">n/a</td>`;
    const all = sums.get(c)!;
    const picked =
      variants[0] === EFFORT_PAIRS
        ? all.filter((s) =>
            /^effort_[a-z]+_to_[a-z]+$/.test(aliasEffort(s.variant, c))
          )
        : all.filter((s) => variants.includes(s.variant));
    if (picked.length === 0) return `<td class="cmp na">not tested</td>`;
    const { tier: t, text, detail } = cellText(picked, marks.get(c)!);
    return `<td class="cmp cmp-${t}" title="${esc(detail)}">${esc(text)}</td>`;
  };

  const head = `<tr><th>Change</th>${cols
    .map((c) => `<th>${esc(COLUMN_TITLES[c] ?? c)}</th>`)
    .join("")}</tr>`;
  const groupRow = (title: string) =>
    `<tr class="group-row"><td colspan="${cols.length + 1}">${esc(title)}</td></tr>`;

  const rows: string[] = [
    groupRow("In a real 6-turn thread (every turn was sent)"),
  ];
  for (const [probe, text] of Object.entries(THREAD_COMPARE)) {
    rows.push(
      `<tr><td>${esc(text)}</td>${cols.map((c) => threadCell(c, probe)).join("")}</tr>`
    );
  }
  let group = "";
  for (const k of CONCEPTS) {
    if (k.group !== group) {
      group = k.group;
      rows.push(
        groupRow(COMPARE_GROUP_TITLES[group] ?? GROUP_TITLES[group] ?? group)
      );
    }
    rows.push(
      `<tr><td>${inline(k.text)}</td>${cols.map((c) => cell(c, k.variants[c])).join("")}</tr>`
    );
  }

  return `<figure class="chart"><figcaption>The same change across APIs and models (each cell: median of 5 trials)</figcaption>
<p class="chart-note" style="margin:-6px 0 10px">Where only part of the cache survives, the cell names what was still cached, from where reuse stopped in the prompt: tools, system prompt, a first exchange, a third message, a last reply, and a final message. Hover a cell for the exact share of the warm prompt. “n/a”: the API has no such setting. “not tested”: not run on that model or mode.</p>
<div class="table-scroll"><table class="compare"><thead>${head}</thead><tbody>
${rows.join("\n")}
</tbody></table></div>
<p class="chart-note">With explicit breakpoints the final message sits after the last breakpoint, so edits to it can’t lose anything. Every finding also has a recorded claim test.</p>
</figure>`;
}

const blog = fs.readFileSync(path.join(root, "blog.md"), "utf8");
const title = blog.match(/^# (.+)$/m)?.[1] ?? "cache_breakers";
let html = await marked.parse(blog);
const blocks = new Map<string, ReturnType<typeof adapterBlocks>>();
const staticSummaries = (name: string) => {
  const obs = allStatic.filter(
    (o) => o.provider === name && main(o) && o.group !== "sweep"
  );
  return sortSummaries(summarise(obs), variantOrder(obs));
};
html = html
  .replace(/<!-- report:compare-static:([\w.+-]+) -->/g, (_, names: string) => {
    const list = names.split("+");
    return multiBarChart(
      `static-${list.join("-")}`,
      `Share of the warm prompt still cached after one change (median of 5 trials per model)`,
      list.map((n) => ({
        label: COLUMN_TITLES[n] ?? n,
        summaries: staticSummaries(n),
      }))
    );
  })
  .replace(/<!-- report:compare -->/g, () =>
    compareTable(Object.keys(ADAPTERS))
  )
  .replace(
    /<!-- report:(tiers|static|tool_loop|layout|sizes|minimum|thread|sweep)(?::([\w.-]+))? -->/g,
    (_, kind: string, name?: string) => {
      const key = name ?? "openai_responses";
      if (!blocks.has(key)) blocks.set(key, adapterBlocks(key));
      const b = blocks.get(key)!;
      return b[kind as keyof typeof b]();
    }
  );

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cache breakers</title>
<meta name="description" content="${esc(title)}">
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --code-bg: #f0efec;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --series-1: #3987e5;
    --series-2: #d95926;
    --code-bg: #262624;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --series-1: #3987e5;
  --series-2: #d95926;
  --code-bg: #262624;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { margin-top: 2.5rem; border-bottom: 1px solid var(--grid); padding-bottom: .3rem; }
h3 { margin-top: 1.8rem; }
p, li { color: var(--ink); }
a { color: var(--series-1); }
code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: .1em .3em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 12px; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; }
.table-scroll, main > table { display: block; overflow-x: auto; }
.chart { background: var(--surface); border: 1px solid var(--grid); border-radius: 10px; padding: 16px; margin: 1.5rem 0 .5rem; position: relative; }
.chart figcaption { font-weight: 600; margin-bottom: 12px; }
.chart-note { color: var(--ink-2); font-size: .85rem; margin: 12px 0 0; }
.bar-axis, .bar-row { display: grid; grid-template-columns: minmax(150px, 34%) 1fr 64px; gap: 10px; align-items: center; }
.axis-scale { display: flex; justify-content: space-between; color: var(--muted); font-size: .75rem; }
.bar-group { color: var(--ink-2); font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 4px; }
.bar-row { padding: 3px 0; border-radius: 4px; outline: none; }
.bar-row:hover, .bar-row:focus { background: var(--code-bg); }
.bar-label { font-size: .82rem; overflow-wrap: anywhere; }
.bar-label code { background: none; padding: 0; }
.bar-track { position: relative; height: 14px; border-left: 1px solid var(--axis); background: linear-gradient(to right, transparent calc(50% - .5px), var(--grid) calc(50% - .5px), var(--grid) calc(50% + .5px), transparent calc(50% + .5px)); }
.mtrack { height: auto; display: flex; flex-direction: column; gap: 2px; padding: 1px 0; }
.mbar { height: 7px; border-radius: 0 4px 4px 0; }
.mbar-none { height: 7px; line-height: 7px; color: var(--muted); font-size: .65rem; padding-left: 4px; }
.s1 { background: var(--series-1); }
.s2 { background: var(--series-2); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin: -4px 0 10px; font-size: .82rem; color: var(--ink-2); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 12px; height: 8px; border-radius: 2px; }
.bar-fill { height: 100%; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 0; }
.bar-none { color: var(--muted); font-size: .75rem; line-height: 14px; padding-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-marker { position: absolute; top: -3px; bottom: -3px; border-left: 2px dashed var(--ink-2); }
.bar-value { font-size: .82rem; font-variant-numeric: tabular-nums; text-align: right; color: var(--ink); }
.bar-n { display: block; color: var(--muted); font-size: .7rem; }
.tip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--axis); border-radius: 8px; padding: 8px 10px; font-size: .8rem; line-height: 1.45; max-width: 320px; box-shadow: 0 4px 16px rgb(0 0 0 / .15); display: none; }
.min-row { display: grid; grid-template-columns: minmax(130px, 30%) 1fr; gap: 10px; align-items: center; padding: 8px 0; }
.min-track { position: relative; height: 22px; border-bottom: 1px solid var(--axis); }
.min-dot { position: absolute; top: 5px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; outline: none; }
.min-dot.hit { background: var(--series-1); box-shadow: 0 0 0 2px var(--surface); }
.min-dot.miss { border: 2px solid var(--ink-2); background: var(--surface); }
.min-rule { position: absolute; top: -4px; bottom: -4px; border-left: 2px dashed var(--ink-2); }
.min-ticks { position: relative; height: 16px; color: var(--muted); font-size: .72rem; }
.min-ticks span { position: absolute; transform: translateX(-50%); }
.layout-strip { display: flex; gap: 2px; }
.layout-seg { background: var(--series-1); color: #fff; border-radius: 4px; padding: 8px; min-width: 0; }
.layout-seg span { display: block; font-weight: 600; font-size: .85rem; overflow-wrap: anywhere; }
.layout-seg small { opacity: .85; font-variant-numeric: tabular-nums; }
.tier { margin: 1.25rem 0; }
.tier h3 { margin-bottom: .2rem; display: flex; align-items: baseline; gap: 8px; }
.tier-count { color: var(--muted); font-size: .85rem; font-weight: 500; }
.cmp { font-size: .82rem; min-width: 6.5rem; }
.compare td:first-child { min-width: 13rem; }
.group-row td { color: var(--ink-2); font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding-top: 14px; }
.cmp-zero { font-weight: 600; }
.cmp.na { color: var(--muted); }
.tier td.area, td.area { color: var(--ink-2); white-space: nowrap; }
.tier table td:nth-child(2) { min-width: 14rem; }
.var-name { display: block; color: var(--muted); font: .72rem ui-monospace, SFMono-Regular, Menlo, monospace; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.table-view { margin: .5rem 0 1.5rem; }
.table-view summary { cursor: pointer; color: var(--ink-2); font-size: .9rem; }
@media (max-width: 560px) {
  .bar-axis { display: none; }
  .bar-row { grid-template-columns: 1fr 56px; grid-template-areas: "label label" "track value"; gap: 2px 8px; padding: 6px 0; }
  .bar-label { grid-area: label; }
  .bar-track { grid-area: track; }
  .bar-value { grid-area: value; }
}
</style>
</head>
<body>
<main>
${html}
<p class="chart-note">Generated by <code>scripts/build-report.ts</code> from <code>blog.md</code> and <code>results/*.csv</code> (${allStatic.length + load("tool_loop").length} trials).</p>
</main>
<div class="tip" role="tooltip"></div>
<script>
const tip = document.querySelector(".tip");
function show(el, x, y) {
  tip.innerHTML = el.dataset.tip;
  tip.style.display = "block";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + 14, innerWidth - w - 8) + "px";
  tip.style.top = (y + h + 20 > innerHeight ? y - h - 14 : y + 14) + "px";
}
for (const row of document.querySelectorAll(".bar-row, .min-dot")) {
  row.addEventListener("mousemove", (e) => show(row, e.clientX, e.clientY));
  row.addEventListener("mouseleave", () => (tip.style.display = "none"));
  row.addEventListener("focus", () => {
    const r = row.getBoundingClientRect();
    show(row, r.left + r.width / 2, r.bottom);
  });
  row.addEventListener("blur", () => (tip.style.display = "none"));
}
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, "report.html"), page);
console.log(
  `wrote report.html (${allStatic.length + load("tool_loop").length} trials)`
);
