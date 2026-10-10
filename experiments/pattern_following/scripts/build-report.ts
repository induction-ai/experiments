/**
 * Builds index.html, the experiment's published page, from blog.md and
 * results/*.csv. Never hand-edit the output; re-run `pnpm report` after any
 * change to the blog or the results.
 *
 * The blog marks where generated content goes with HTML comments, which
 * render as nothing in blog.md itself:
 *   <!-- report:copy-curve -->  share of replies that copy, by examples in the history
 *   <!-- report:reasoning -->   reasoning tokens of replies that copied vs didn't
 *   <!-- report:replay -->      real-trajectory replay: share of replies that wrote a stub
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import {
  copyRates,
  loadResults,
  REASONING_SOURCES,
  reasoningPoints,
  replayRates,
  SERIES,
  wilson,
  type RatePoint,
} from "../src/analysis.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Escapes text, then renders `code` spans the way the blog writes them. */
const inline = (s: string) =>
  esc(s).replace(/`([^`]+)`/g, (_, code: string) => `<code>${code}</code>`);

const pct = (k: number, n: number) => `${Math.round((100 * k) / n)}%`;

type Shape = "circle" | "square" | "triangle";
const SHAPES: Shape[] = ["circle", "square", "triangle"];

function marker(shape: Shape, x: number, y: number, cls: string): string {
  if (shape === "circle")
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="4.5"/>`;
  if (shape === "square")
    return `<rect class="${cls}" x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1"/>`;
  return `<path class="${cls}" d="M${x} ${y - 5.5} L${x + 5} ${y + 3.5} L${x - 5} ${y + 3.5} Z"/>`;
}

function legendKey(shape: Shape, slot: number): string {
  return `<svg class="key" width="26" height="12" aria-hidden="true"><line class="s${slot}-line" x1="1" y1="6" x2="25" y2="6"/>${marker(shape, 13, 6, `s${slot}-mark`)}</svg>`;
}

function copyCurve(): string {
  const W = 720;
  const H = 340;
  const m = { top: 16, right: 20, bottom: 44, left: 48 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const series = SERIES.map((s) => ({
    ...s,
    points: copyRates(loadResults(s.file), s),
  }));
  const xs = [
    ...new Set(series.flatMap((s) => s.points.map((p) => p.examples))),
  ].sort((a, b) => a - b);
  const xMax = 75;
  const x = (v: number) => m.left + (v / xMax) * plotW;
  const y = (v: number) => m.top + (1 - v) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`
    )
    .join("");
  const xTicks = xs
    .map(
      (v) =>
        `<text class="tick" x="${x(v)}" y="${H - m.bottom + 18}" text-anchor="middle">${v}</text>`
    )
    .join("");

  const marks = series
    .map((s, i) => {
      const slot = i + 1;
      const shape = SHAPES[i]!;
      const line = s.points
        .map((p) => `${x(p.examples)},${y(p.copied / p.n)}`)
        .join(" ");
      const whiskers = s.points
        .map((p) => {
          const [lo, hi] = wilson(p.copied, p.n);
          const dx = (i - 1) * 3;
          return `<line class="s${slot}-whisker" x1="${x(p.examples) + dx}" x2="${x(p.examples) + dx}" y1="${y(lo)}" y2="${y(hi)}"/>`;
        })
        .join("");
      const points = s.points
        .map((p) => {
          const tip = `${s.label}<br><b>${p.examples} examples</b>: ${p.copied} of ${p.n} replies copied (${pct(p.copied, p.n)})`;
          return (
            marker(shape, x(p.examples), y(p.copied / p.n), `s${slot}-mark`) +
            `<circle class="hit" cx="${x(p.examples)}" cy="${y(p.copied / p.n)}" r="12" data-tip="${esc(inline(tip))}"/>`
          );
        })
        .join("");
      return `<g>${whiskers}<polyline class="s${slot}-line" points="${line}"/>${points}</g>`;
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of replies that copied, by number of examples in the history">
  ${grid}
  <line class="axis" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"/>
  ${xTicks}
  <text class="axis-title" x="${m.left + plotW / 2}" y="${H - 6}" text-anchor="middle">copies of the pattern already in the history</text>
  ${marks}
</svg>`;

  const legend = series
    .map(
      (s, i) =>
        `<span class="legend-item">${legendKey(SHAPES[i]!, i + 1)}${inline(s.label)}</span>`
    )
    .join("");

  const tableRows = xs
    .map((v) => {
      const cells = series
        .map((s) => {
          const p = s.points.find((q: RatePoint) => q.examples === v);
          return p
            ? `<td>${p.copied}/${p.n} (${pct(p.copied, p.n)})</td>`
            : "<td>–</td>";
        })
        .join("");
      return `<tr><td>${v}</td>${cells}</tr>`;
    })
    .join("");
  return `<figure class="chart">
  <figcaption><b>Share of replies that copied the repeated search</b><span>Each point is 5 to 16 replies; bars are 95% intervals.</span></figcaption>
  <div class="legend">${legend}</div>
  ${svg}
  <details><summary>Show the numbers</summary>
    <table><thead><tr><th>Examples in history</th>${series.map((s) => `<th>${inline(s.label)}</th>`).join("")}</tr></thead><tbody>${tableRows}</tbody></table>
  </details>
</figure>`;
}

function replayChart(): string {
  const rates = replayRates().filter((r) => r.n > 0);
  const W = 720;
  const rowH = 46;
  const m = { top: 8, right: 120, bottom: 36, left: 210 };
  const H = m.top + rates.length * rowH + m.bottom;
  const plotW = W - m.left - m.right;
  const x = (v: number) => m.left + v * plotW;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (v) =>
        `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${m.top}" y2="${H - m.bottom}"/>` +
        `<text class="tick" x="${x(v)}" y="${H - m.bottom + 18}" text-anchor="middle">${v * 100}%</text>`
    )
    .join("");
  const bars = rates
    .map((r, i) => {
      const cy = m.top + rowH * (i + 0.5);
      const share = r.copied / r.n;
      const [lo, hi] = wilson(r.copied, r.n);
      const barH = 22;
      const w = Math.max(0, x(share) - x(0));
      const tip = `<b>${esc(r.label)}</b>: ${r.copied} of ${r.n} replies wrote a stub (${pct(r.copied, r.n)})`;
      const bar =
        w > 0
          ? `<path class="s1-bar" d="M${x(0)} ${cy - barH / 2} H${x(0) + w - 4} Q${x(0) + w} ${cy - barH / 2} ${x(0) + w} ${cy - barH / 2 + 4} V${cy + barH / 2 - 4} Q${x(0) + w} ${cy + barH / 2} ${x(0) + w - 4} ${cy + barH / 2} H${x(0)} Z"/>`
          : "";
      return (
        `<text class="axis-title" x="${m.left - 10}" y="${cy + 4}" text-anchor="end">${esc(r.label)}</text>` +
        bar +
        `<line class="s1-whisker" x1="${x(lo)}" x2="${x(hi)}" y1="${cy}" y2="${cy}"/>` +
        `<text class="value" x="${x(Math.max(share, hi)) + 8}" y="${cy + 4}">${r.copied}/${r.n} (${pct(r.copied, r.n)})</text>` +
        `<rect class="hit" x="${m.left}" y="${cy - rowH / 2}" width="${plotW}" height="${rowH}" data-tip="${tip}"/>`
      );
    })
    .join("");
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of replies that wrote a stub, by condition">
  ${grid}
  <line class="axis" x1="${x(0)}" x2="${x(0)}" y1="${m.top}" y2="${H - m.bottom}"/>
  ${bars}
</svg>`;
  return `<figure class="chart">
  <figcaption><b>Replies that wrote a stubbed argument</b><span>10 real trajectories, up to 12 tool turns each, 2 replies per turn. Lines are 95% intervals.</span></figcaption>
  ${svg}
</figure>`;
}

const BINS: { label: string; test: (t: number) => boolean }[] = [
  { label: "0", test: (t) => t === 0 },
  { label: "1–100", test: (t) => t >= 1 && t <= 100 },
  { label: "101–200", test: (t) => t >= 101 && t <= 200 },
  { label: "201–300", test: (t) => t >= 201 && t <= 300 },
  { label: "301–400", test: (t) => t >= 301 && t <= 400 },
  { label: "401+", test: (t) => t >= 401 },
];

function reasoningChart(): string {
  const points = reasoningPoints();
  const groups = [
    { label: "copied", slot: 1, rows: points.filter((p) => p.copied) },
    { label: "didn't copy", slot: 0, rows: points.filter((p) => !p.copied) },
  ].map((g) => ({
    ...g,
    counts: BINS.map(
      (b) => g.rows.filter((p) => b.test(p.reasoningTokens)).length
    ),
  }));

  const W = 720;
  const H = 300;
  const m = { top: 24, right: 16, bottom: 44, left: 48 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const share = (g: (typeof groups)[number], b: number) =>
    (100 * g.counts[b]!) / g.rows.length;
  const y = (v: number) => m.top + (1 - v / 100) * plotH;
  const band = plotW / BINS.length;
  const barW = 22;

  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) =>
        `<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${m.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`
    )
    .join("");

  const bars = BINS.map((bin, b) => {
    const cx = m.left + band * (b + 0.5);
    const tick = `<text class="tick" x="${cx}" y="${H - m.bottom + 18}" text-anchor="middle">${bin.label}</text>`;
    const pair = groups
      .map((g, gi) => {
        const count = g.counts[b]!;
        const pct = share(g, b);
        const bx = cx + (gi === 0 ? -barW - 1 : 1);
        const top = y(pct);
        const h = y(0) - top;
        const tip = `<b>${g.label}</b>: ${count} of ${g.rows.length} replies (${Math.round(pct)}%) used ${bin.label} reasoning tokens`;
        const shape =
          h > 0
            ? `<path class="s${g.slot}-bar" d="M${bx} ${y(0)} V${top + 4} Q${bx} ${top} ${bx + 4} ${top} H${bx + barW - 4} Q${bx + barW} ${top} ${bx + barW} ${top + 4} V${y(0)} Z"/>`
            : "";
        const value =
          count > 0
            ? `<text class="value" x="${bx + barW / 2}" y="${top - 5}" text-anchor="middle">${Math.round(pct)}%</text>`
            : "";
        return `${shape}${value}<rect class="hit" x="${bx - 2}" y="${m.top}" width="${barW + 4}" height="${plotH}" data-tip="${esc(tip)}"/>`;
      })
      .join("");
    return tick + pair;
  }).join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reasoning tokens used by replies that copied and replies that didn't">
  ${grid}
  <line class="axis" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"/>
  ${bars}
  <text class="axis-title" x="${m.left + plotW / 2}" y="${H - 6}" text-anchor="middle">reasoning tokens in the reply</text>
</svg>`;

  const legend = groups
    .map(
      (g) =>
        `<span class="legend-item"><svg class="key" width="12" height="12" aria-hidden="true"><rect class="s${g.slot}-bar" width="12" height="12" rx="2"/></svg>${g.label} (${g.rows.length} replies)</span>`
    )
    .join("");
  const rows = groups
    .map(
      (g) =>
        `<tr><td>${g.label}</td>${g.counts.map((c) => `<td>${c} (${Math.round((100 * c) / g.rows.length)}%)</td>`).join("")}<td>${g.rows.length}</td></tr>`
    )
    .join("");
  const sources = REASONING_SOURCES.map((s) => inline(s.setup)).join("; ");

  return `<figure class="chart">
  <figcaption><b>Reasoning tokens before copying a stub vs. not</b><span>Every reply from every run, all at reasoning effort xhigh. Bars are each group's share of its replies.</span></figcaption>
  <div class="legend">${legend}</div>
  ${svg}
  <p class="note">Sweeps included: ${sources}.</p>
  <details><summary>Show the numbers</summary>
    <table><thead><tr><th>Reply</th>${BINS.map((b) => `<th>${b.label}</th>`).join("")}<th>Total</th></tr></thead><tbody>${rows}</tbody></table>
  </details>
</figure>`;
}

const CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10); --code-bg: #f0efea;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --code-bg: #242422;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --code-bg: #242422;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 80px; }
h1 { font-size: 30px; line-height: 1.2; margin: 0 0 16px; }
h2 { font-size: 22px; margin: 40px 0 12px; }
h3 { font-size: 18px; margin: 28px 0 8px; }
p, li { color: var(--ink); }
a { color: var(--s1); }
code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 12px 0; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th { color: var(--ink-2); font-weight: 600; }
blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--axis); color: var(--ink-2); }
.chart { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 16px; margin: 24px 0; position: relative; }
.chart figcaption { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.chart figcaption span { color: var(--ink-2); font-size: 14px; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; color: var(--ink-2); margin-bottom: 4px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend .key { width: auto; display: inline; }
.note { font-size: 13px; color: var(--ink-2); margin: 8px 0 0; }
details summary { cursor: pointer; font-size: 14px; color: var(--ink-2); margin-top: 8px; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 12px; }
.axis-title { fill: var(--ink-2); font-size: 13px; }
.value { fill: var(--ink-2); font-size: 12px; }
.s1-line, .s2-line, .s3-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.s1-line { stroke: var(--s1); } .s2-line { stroke: var(--s2); } .s3-line { stroke: var(--s3); }
.s1-whisker, .s2-whisker, .s3-whisker { stroke-width: 1; opacity: 0.45; }
.s1-whisker { stroke: var(--s1); } .s2-whisker { stroke: var(--s2); } .s3-whisker { stroke: var(--s3); }
.s1-mark, .s2-mark, .s3-mark { stroke: var(--surface); stroke-width: 2; }
.s0-bar { fill: var(--muted); }
.s1-mark, .s1-bar { fill: var(--s1); } .s2-mark, .s2-bar { fill: var(--s2); } .s3-mark { fill: var(--s3); }
.hit { fill: transparent; cursor: default; }
@media (max-width: 560px) { .tick, .value { font-size: 20px; } .axis-title { font-size: 21px; } }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12); border-radius: 6px; padding: 6px 9px; font-size: 13px; line-height: 1.4; max-width: 280px; display: none; z-index: 2; }
`;

const TIP_SCRIPT = `
document.querySelectorAll(".chart").forEach((chart) => {
  const tip = document.createElement("div");
  tip.className = "tip";
  chart.appendChild(tip);
  chart.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("pointerenter", () => { tip.innerHTML = el.getAttribute("data-tip"); tip.style.display = "block"; });
    el.addEventListener("pointermove", (e) => {
      const box = chart.getBoundingClientRect();
      const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 8);
      tip.style.left = left + "px";
      tip.style.top = (e.clientY - box.top - tip.offsetHeight - 10) + "px";
    });
    el.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  });
});
`;

const blog = fs.readFileSync(path.join(root, "blog.md"), "utf8");
const title = blog.match(/^# (.+)$/m)?.[1] ?? "pattern_following";
const body = (marked.parse(blog) as string)
  .replace("<!-- report:copy-curve -->", copyCurve())
  .replace("<!-- report:reasoning -->", reasoningChart())
  .replace("<!-- report:replay -->", replayChart());

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
<script>${TIP_SCRIPT}</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, "index.html"), html);
console.log(`wrote ${path.join(root, "index.html")}`);
