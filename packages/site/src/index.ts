/**
 * Builds the site's home page (index.html at the repo root) from each
 * experiment's blog.md and log.md. Nothing here is hand-maintained: the title
 * and summary come from the blog, the dates from the log's dated headings.
 */
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

export interface Experiment {
  /** Folder name under experiments/; its page is experiments/<name>/. */
  name: string;
  /** The blog's first `# ` heading, as inline HTML. */
  title: string;
  /** The blog's first paragraph after the title, as inline HTML. */
  summary: string;
  /** First and last `## YYYY-MM-DD` heading in log.md. */
  started: string;
  updated: string;
}

const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})\b/gm;

export function parseExperiment(
  name: string,
  blog: string,
  log: string
): Experiment {
  const lines = blog.split("\n");
  const titleAt = lines.findIndex((l) => l.startsWith("# "));
  if (titleAt === -1) throw new Error(`${name}/blog.md has no "# " title`);

  const rest = lines.slice(titleAt + 1);
  const start = rest.findIndex((l) => l.trim() !== "");
  const end = rest.findIndex((l, i) => i > start && l.trim() === "");
  const paragraph =
    start === -1 ? [] : rest.slice(start, end === -1 ? undefined : end);

  const dates = [...log.matchAll(DATE_HEADING)].map((m) => m[1]!).sort();
  if (dates.length === 0) {
    throw new Error(`${name}/log.md has no "## YYYY-MM-DD" entries`);
  }

  return {
    name,
    title: inline(lines[titleAt]!.slice(2)),
    summary: inline(paragraph.join(" ")),
    started: dates[0]!,
    updated: dates[dates.length - 1]!,
  };
}

/** Every folder in `dir` that has both a blog.md and a log.md. */
export function readExperiments(dir: string): Experiment[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
    .filter(
      (p) =>
        fs.existsSync(path.join(p, "blog.md")) &&
        fs.existsSync(path.join(p, "log.md"))
    )
    .map((p) =>
      parseExperiment(
        path.basename(p),
        fs.readFileSync(path.join(p, "blog.md"), "utf8"),
        fs.readFileSync(path.join(p, "log.md"), "utf8")
      )
    )
    .sort(
      (a, b) =>
        b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name)
    );
}

function inline(markdown: string): string {
  return marked.parseInline(markdown.trim(), { async: false });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** 2026-09-18 → 18 Sep 2026 */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function dateLine(e: Experiment): string {
  const time = (iso: string) =>
    `<time datetime="${esc(iso)}">${formatDate(iso)}</time>`;
  return e.started === e.updated
    ? time(e.started)
    : `${time(e.started)} to ${time(e.updated)}`;
}

export function renderIndex(experiments: Experiment[]): string {
  const items = experiments
    .map(
      (e) => `<li class="exp">
<h2><a href="experiments/${esc(e.name)}/">${e.title}</a></h2>
<p class="meta">${dateLine(e)} · <a href="experiments/${esc(e.name)}/log.html">log</a></p>
<p>${e.summary}</p>
</li>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Experiments</title>
<meta name="description" content="Reproducible experiments on LLM API behaviour, with recorded tests.">
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --grid: #e1e0d9;
  --link: #2a78d6;
  --code-bg: #f0efec;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --grid: #2c2c2a;
    --link: #3987e5;
    --code-bg: #262624;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --grid: #2c2c2a;
  --link: #3987e5;
  --code-bg: #262624;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; }
.intro { color: var(--ink-2); margin: 0 0 2rem; }
a { color: var(--link); }
code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: .1em .3em; border-radius: 4px; }
ol { list-style: none; margin: 0; padding: 0; }
.exp { border-top: 1px solid var(--grid); padding: 1.25rem 0; }
.exp h2 { font-size: 1.25rem; line-height: 1.35; margin: 0 0 .25rem; }
.exp h2 a { color: var(--ink); text-decoration: none; }
.exp h2 a:hover, .exp h2 a:focus { color: var(--link); text-decoration: underline; }
.meta { color: var(--ink-2); font-size: .85rem; margin: 0 0 .5rem; font-variant-numeric: tabular-nums; }
.exp > p:last-child { margin: 0; }
</style>
</head>
<body>
<main>
<h1>Experiments</h1>
<p class="intro">Reproducible experiments on LLM API behaviour. Every claim has a recorded test that reproduces it. Code, data and recordings are on <a href="https://github.com/induction-ai/experiments">GitHub</a>.</p>
<ol>
${items}
</ol>
</main>
</body>
</html>
`;
}
