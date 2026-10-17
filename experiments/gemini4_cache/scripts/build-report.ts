/**
 * Builds index.html, the experiment's published page, from blog.md and
 * results/*.csv. Never hand-edit the output; re-run `pnpm report` after any
 * change to the blog or the results.
 *
 * The blog marks where generated content goes with HTML comments, which
 * render as nothing in blog.md itself:
 *   <!-- report:chains -->     append-only threads, per model and chain
 *   <!-- report:threshold -->  hit/miss by prompt tokens, per model and shape
 *   <!-- report:tail -->       prompt − cached on identical repeats
 *   <!-- report:edit -->       one-word edits at four positions
 *   <!-- report:boundary -->   reusing an earlier, shorter request
 *   <!-- report:sig -->        extending past a function-call signature
 *   <!-- report:inflation -->  argon's hidden prompt tokens
 *   <!-- report:tailExamples --> real argon requests drawn as cached/full bars
 *   <!-- report:tailVariants --> the repeat tail with one factor changed
 *   <!-- report:twoTurns -->   the two-conversation example, its code, and the edge
 *   <!-- report:smallTurns --> 4,100 tokens, then 1,000 or 2,100 more
 *   <!-- report:exact4100 -->  the same case at exact sizes, on OpenAI and Gemini
 *   <!-- report:breakers -->   one change at a time on a warm argon request
 *
 * Every number aggregates all rows of its CSV and shows n beside it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { groupBy, median, num, readCsv, type Row } from "../src/analyze.js";
import { BREAKERS } from "../src/breakers.js";

const BREAKER_DESCRIPTIONS = Object.fromEntries(
  BREAKERS.map((b) => [b.name, b.description])
);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const csv = (name: string) =>
  readCsv(path.join(root, "results", `${name}.csv`));

const MODELS = ["gemini-4-argon", "gemini-3.1-pro-preview"];
const SHORT: Record<string, string> = {
  "gemini-4-argon": "argon",
  "gemini-3.1-pro-preview": "3.1",
};
/** Cached counts below this are a tiny header other requests share. */
const NOISE = 200;

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US");

function range(xs: number[]): string {
  if (xs.length === 0) return "–";
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

function table(
  head: string[],
  rows: string[][],
  numeric: number[] = []
): string {
  const th = head
    .map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ""}>${h}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`
    )
    .join("\n");
  return `<div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const source = (script: string, file: string, n: number) =>
  `<p class="chart-note">From <code>scripts/${script}</code> → <code>results/${file}</code>, ${n} trials.</p>`;

// ---------------------------------------------------------------- chains

function chains(): string {
  const rows = csv("extend");
  const trials = groupBy(rows, (r) => `${r.model}|${r.chain}|${r.trial}`);
  interface Part {
    hits: number;
    steps: number;
    gaps: number[];
  }
  const blank = (): Part => ({ hits: 0, steps: 0, gaps: [] });
  const cells = new Map<
    string,
    { first: Part; later: Part; missAt: number[]; n: number }
  >();
  for (const [key, rs] of trials) {
    const [model, chain] = key.split("|");
    const k = `${model}|${chain}`;
    const c = cells.get(k) ?? {
      first: blank(),
      later: blank(),
      missAt: [],
      n: 0,
    };
    c.n++;
    rs.sort((a, b) => Number(a.step) - Number(b.step));
    for (let i = 1; i < rs.length; i++) {
      const part = i === 1 ? c.first : c.later;
      const cached = num(rs[i]!.cached) ?? 0;
      part.steps++;
      if (cached > NOISE) {
        part.hits++;
        part.gaps.push(num(rs[i - 1]!.prompt)! - cached);
      } else c.missAt.push(i);
    }
    cells.set(k, c);
  }
  const gaps = (xs: number[]) => {
    // Distinct values with counts when they cluster, else a range.
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    if (counts.size > 3) return range(xs);
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([v, k]) =>
          `${v < 0 ? "−" + fmt(-v) : fmt(v)}${counts.size > 1 ? ` (${k}×)` : ""}`
      )
      .join(", ");
  };
  const part = (p: Part) => (p.steps ? `${p.hits} / ${p.steps}` : "–");
  const order = [
    "text_chain",
    "tool_chain",
    "long_chain",
    "mid_chain",
    "para_chain",
  ];
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const chain of order) {
      const c = cells.get(`${model}|${chain}`);
      if (!c) continue;
      const missAt = [...new Set(c.missAt)].sort();
      out.push([
        SHORT[model]!,
        `<code>${chain}</code>`,
        part(c.first),
        gaps(c.first.gaps),
        part(c.later),
        gaps(c.later.gaps),
        missAt.length
          ? `step ${missAt.join(", ")} (${c.missAt.length}×)`
          : "none",
        String(c.n),
      ]);
    }
  }
  return (
    table(
      [
        "Model",
        "Chain",
        "Step 1 reused step 0",
        "Held back",
        "Steps 2+ reused the previous step",
        "Held back",
        "Misses",
        "n",
      ],
      out,
      [2, 3, 4, 5, 7]
    ) +
    `<p class="chart-note">“Held back” is the previous request’s prompt minus what this request cached; −1 means the whole previous prompt plus one token.</p>` +
    source("run-extend.ts", "extend.csv", trials.size)
  );
}

// ------------------------------------------------------------- threshold

interface Dot {
  shape: string;
  words: number;
  prompt: number;
  hit: boolean;
  cached: string;
}

const SHAPES = ["one", "two_cold", "two_grown", "many_cold", "many_grown"];

function thresholdChart(
  model: string,
  dots: Dot[],
  lo: number,
  hi: number,
  rule: number | null
): string {
  const x = (t: number) =>
    ((Math.min(hi, Math.max(lo, t)) - lo) / (hi - lo)) * 100;
  const rows = SHAPES.map((shape) => {
    const ps = dots.filter((d) => d.shape === shape);
    const marks = ps
      .map(
        (d) =>
          `<span class="min-dot ${d.hit ? "hit" : "miss"}" style="left:${x(d.prompt).toFixed(2)}%" tabindex="0" data-tip="${esc(
            `<strong>${SHORT[model]} ${shape}</strong><br>${fmt(d.prompt)} prompt tokens (${fmt(d.words)} words)<br>${d.hit ? "cached" : "never cached"}: ${d.cached}`
          )}"></span>`
      )
      .join("");
    return `<div class="min-row"><div class="bar-label"><code>${shape}</code></div><div class="min-track">${marks}${
      rule
        ? `<span class="min-rule" style="left:${x(rule).toFixed(2)}%"></span>`
        : ""
    }</div></div>`;
  }).join("\n");
  const step = (hi - lo) / 4;
  const ticks = Array.from({ length: 5 }, (_, i) => lo + i * step)
    .map((t) => `<span style="left:${x(t).toFixed(2)}%">${fmt(t)}</span>`)
    .join("");
  return `<figure class="chart"><figcaption>${SHORT[model]}: cached or not, by prompt tokens of the final request (${dots.length} trials)</figcaption>
${rows}
<div class="min-row"><span></span><div class="min-ticks">${ticks}</div></div>
<p class="chart-note">Filled dot: cached on some send of the final request. Hollow ring: never cached.${
    rule ? ` Dashed line: ${fmt(rule)} tokens.` : ""
  } Hover a dot for its sends.</p>
</figure>`;
}

function threshold(): string {
  const rows = csv("minimum");
  const dots = (model: string): Dot[] =>
    rows
      .filter((r) => r.model === model)
      .map((r) => ({
        shape: r.shape!,
        words: Number(r.words),
        prompt: num(r.prompt)!,
        hit: (num(r.cached_max) ?? 0) > 0,
        cached: (r.cached_all ?? "").split(";").join(", "),
      }));
  const argon = dots("gemini-4-argon");
  const pro = dots("gemini-3.1-pro-preview");
  const edge = (ds: Dot[]) =>
    SHAPES.map((shape) => {
      const s = ds.filter((d) => d.shape === shape);
      const miss = s.filter((d) => !d.hit).map((d) => d.prompt);
      const hit = s.filter((d) => d.hit).map((d) => d.prompt);
      return [
        shape,
        miss.length ? fmt(Math.max(...miss)) : "–",
        hit.length ? fmt(Math.min(...hit)) : "–",
        String(s.length),
      ];
    });
  const proCells = groupBy(pro, (d) => `${d.words}`);
  const proRows = [...proCells.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([words, ds]) => [
      fmt(Number(words)),
      ...SHAPES.map((shape) => {
        const s = ds.filter((d) => d.shape === shape);
        return `${s.filter((d) => d.hit).length} / ${s.length}`;
      }),
    ]);
  return (
    thresholdChart("gemini-4-argon", argon, 3800, 5900, 4096) +
    `<details class="table-view"><summary>argon: largest miss and smallest hit per shape</summary>${table(
      ["Shape", "Largest prompt never cached", "Smallest prompt cached", "n"],
      edge(argon).map((r) => [`<code>${r[0]}</code>`, r[1]!, r[2]!, r[3]!]),
      [1, 2, 3]
    )}</details>` +
    thresholdChart("gemini-3.1-pro-preview", pro, 6000, 12200, null) +
    `<details class="table-view" open><summary>3.1: trials cached / trials, by size and shape</summary>${table(
      ["Words", ...SHAPES.map((s) => `<code>${s}</code>`)],
      proRows,
      [0, 1, 2, 3, 4, 5]
    )}</details>` +
    source("run-minimum.ts", "minimum.csv", rows.length)
  );
}

// ------------------------------------------------------------------ tail

function tail(): string {
  const rows = csv("repeats");
  const cells = groupBy(rows, (r) => `${r.model}|${r.words}|${r.ask}`);
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const [key, rs] of [...cells.entries()].sort(
      (a, b) => Number(a[0].split("|")[1]) - Number(b[0].split("|")[1])
    )) {
      if (!key.startsWith(`${model}|`)) continue;
      const [, words, ask] = key.split("|");
      const later = rs.filter((r) => Number(r.send) > 0);
      const hits = later.filter((r) => (num(r.cached) ?? 0) > 0);
      const gaps = hits.map((r) => num(r.prompt)! - num(r.cached)!);
      const outputs = rs.map((r) => num(r.output) ?? 0);
      out.push([
        SHORT[model]!,
        fmt(Number(words)),
        ask!,
        fmt(median(rs.map((r) => num(r.prompt)!))),
        `${hits.length} / ${later.length}`,
        range(gaps),
        range(outputs),
        String(new Set(rs.map((r) => r.trial)).size),
      ]);
    }
  }
  return (
    table(
      [
        "Model",
        "Words",
        "Reply",
        "Prompt",
        "Repeats that hit",
        "Held back (prompt − cached)",
        "Output tokens",
        "n",
      ],
      out,
      [1, 3, 4, 5, 6, 7]
    ) +
    source(
      "run-repeats.ts",
      "repeats.csv",
      new Set(rows.map((r) => r.trial)).size
    )
  );
}

// ------------------------------------------------------------------ edit

function edit(): string {
  const rows = csv("edit");
  const trials = groupBy(rows, (r) => r.trial!);
  const shapeTitles: Record<string, string> = {
    one: "one message",
    split: "two messages, split at 40%",
  };
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const shape of Object.keys(shapeTitles)) {
      const ts = [...trials.values()].filter(
        (rs) => rs[0]!.model === model && (rs[0]!.shape || "one") === shape
      );
      if (ts.length === 0) continue;
      const base = ts.map(
        (rs) =>
          num(rs.find((r) => r.kind === "base" && r.send === "1")?.cached)!
      );
      const cells: string[] = [];
      for (const frac of ["0.1", "0.5", "0.9", "0.98"]) {
        const c = ts
          .map((rs) =>
            num(rs.find((r) => r.kind === "edit" && r.frac === frac)?.cached)
          )
          .filter((x): x is number => x !== null);
        cells.push(range(c));
      }
      out.push([
        SHORT[model]!,
        shapeTitles[shape]!,
        range(base),
        ...cells,
        String(ts.length),
      ]);
    }
  }
  return (
    table(
      [
        "Model",
        "Shape",
        "Warm repeat",
        "Edit at 10%",
        "50%",
        "90%",
        "98%",
        "n",
      ],
      out,
      [2, 3, 4, 5, 6, 7]
    ) +
    `<p class="chart-note">Cached tokens. One word replaced, each edit sent once; the text is ~20,000 tokens, and its cached part ends about 90% of the way in.</p>` +
    source("run-edit.ts", "edit.csv", trials.size)
  );
}

// -------------------------------------------------------------- boundary

function boundary(): string {
  const rows = csv("boundary");
  const titles: Record<string, string> = {
    cold: "edit the last message (no shorter request sent before)",
    after_u1: "send [u1] first, then edit the last message",
    edit_u1: "send [u1] first, then edit inside u1",
  };
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const variant of ["cold", "after_u1", "edit_u1"]) {
      const rs = rows.filter((r) => r.model === model && r.variant === variant);
      if (rs.length === 0) continue;
      const a1 = rs.filter((r) => (num(r.cached_a1) ?? 0) > NOISE).length;
      const ed = rs.map((r) => num(r.cached_edited) ?? 0);
      const edHits = ed.filter((x) => x > NOISE).length;
      const both = rs.filter(
        (r) =>
          (num(r.cached_a1) ?? 0) > NOISE && (num(r.cached_edited) ?? 0) > NOISE
      ).length;
      out.push([
        SHORT[model]!,
        titles[variant]!,
        variant === "cold" ? "–" : `${a1} / ${rs.length}`,
        `${edHits} / ${rs.length}`,
        range(ed),
        variant === "after_u1" ? `${both} / ${rs.length}` : "–",
        String(rs.length),
      ]);
    }
  }
  return (
    table(
      [
        "Model",
        "Procedure",
        "A’s first send reused [u1]",
        "Edited request reused something",
        "Edited request cached",
        "Both",
        "n",
      ],
      out,
      [2, 3, 4, 5, 6]
    ) + source("run-boundary.ts", "boundary.csv", rows.length)
  );
}

// ------------------------------------------------------------------- sig

function sig(): string {
  const rows = csv("sig");
  const out: string[][] = [];
  const billing: string[][] = [];
  for (const model of MODELS) {
    for (const variant of ["sig", "text"]) {
      const rs = rows.filter((r) => r.model === model && r.variant === variant);
      if (rs.length === 0) continue;
      const warm = rs.filter((r) => (num(r.cached_a2) ?? 0) > NOISE);
      const kept = warm.filter(
        (r) => Math.abs(num(r.cached_c1)! - num(r.cached_a2)!) < 50
      );
      const lost = warm.filter((r) => num(r.cached_c1)! < NOISE);
      const partial = warm.length - kept.length - lost.length;
      const inflated = rs.filter(
        (r) => num(r.prompt_c)! - (num(r.ct_c) ?? num(r.prompt_c)!) > 100
      );
      out.push([
        SHORT[model]!,
        variant === "sig" ? "function call + signature" : "text only (control)",
        variant === "sig" ? range(rs.map((r) => num(r.sig_bytes)!)) : "–",
        `${kept.length} / ${warm.length}`,
        `${lost.length} / ${warm.length}`,
        `${partial} / ${warm.length}`,
        String(rs.length - warm.length),
        model === "gemini-4-argon" ? `${inflated.length}` : "–",
        String(rs.length),
      ]);
      if (variant === "sig") {
        billing.push([
          SHORT[model]!,
          range(
            rs
              .map((r) => num(r.prompt_a)! - (num(r.ct_a) ?? NaN))
              .filter(Number.isFinite)
          ),
          rs.every((r) => r.ct_a_nosig === "")
            ? "rejected"
            : `${rs.filter((r) => r.ct_a === r.ct_a_nosig).length} / ${rs.length}`,
          `${rs.filter((r) => r.prompt_c === r.ct_c).length} / ${rs.length}`,
          `${rs.filter((r) => num(r.prompt_c)! < num(r.prompt_a)!).length} / ${rs.length}`,
          `${rs.filter((r) => /thought_signature/.test(r.ct_error ?? "")).length} / ${rs.length}`,
        ]);
      }
    }
  }
  return (
    table(
      [
        "Model",
        "Turn m1",
        "Signature bytes",
        "C kept all of A",
        "C lost everything",
        "C inflated",
        "n",
      ],
      out,
      [3, 4, 5, 6]
    ) +
    `<p class="chart-note">“C kept all of A”: the first send of the extended thread cached within 50 tokens of A’s warm repeat. Counted over trials where A’s repeat was cached; the others are counted in “A’s repeat not cached”.</p>` +
    `<h4>Billing and countTokens, function-call variant</h4>` +
    table(
      [
        "Model",
        "A: generateContent − countTokens",
        "countTokens same with signature stripped",
        "C: generateContent = countTokens",
        "C billed less than A",
        "countTokens rejects stripped signature",
      ],
      billing,
      [1, 2, 3, 4, 5]
    ) +
    source("run-sig.ts", "sig.csv", rows.length)
  );
}

// ------------------------------------------------------------- inflation

function inflation(): string {
  const rows = csv("inflation");
  const out: string[][] = [];
  const cells = groupBy(
    rows,
    (r) => `${r.model}|${r.shape}|${r.words}|${r.system}`
  );
  const order = (k: string) => {
    const [m, s, w, sys] = k.split("|");
    return [
      MODELS.indexOf(m!),
      ["one", "two_cold", "many_cold"].indexOf(s!),
      Number(w),
      sys === "none" ? 0 : 1,
    ];
  };
  const keys = [...cells.keys()].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  });
  for (const k of keys) {
    const rs = cells.get(k)!;
    const [model, shape, words, system] = k.split("|");
    const d = rs.flatMap((r) => [
      num(r.prompt_ok)! - num(r.counted_ok)!,
      num(r.prompt_yes)! - num(r.counted_yes)!,
    ]);
    const inf = d.filter((x) => x > 300);
    const flips = rs.filter(
      (r) =>
        num(r.prompt_ok)! - num(r.counted_ok)! > 300 !==
        num(r.prompt_yes)! - num(r.counted_yes)! > 300
    ).length;
    out.push([
      SHORT[model!]!,
      `<code>${shape}</code>`,
      fmt(Number(words)),
      system!,
      `${inf.length} / ${d.length}`,
      inf.length ? range(inf) : "–",
      String(flips),
      String(rs.length),
    ]);
  }
  return (
    table(
      [
        "Model",
        "Shape",
        "Words",
        "System instruction",
        "Sends inflated",
        "Hidden tokens",
        "Trials where the one-word change flipped it",
        "n",
      ],
      out,
      [2, 4, 5, 6, 7]
    ) + source("run-inflation.ts", "inflation.csv", rows.length)
  );
}

// -------------------------------------------------------- tail examples

interface Seg {
  tokens: number;
  kind: "cached" | "full" | "new";
  label: string;
}

/** One request as a bar: each segment's width is its share of `scale`. */
function bar(title: string, segs: Seg[], scale: number): string {
  const total = segs.reduce((n, x) => n + x.tokens, 0);
  const parts = segs
    .filter((x) => x.tokens > 0)
    .map(
      (x) =>
        `<span class="seg ${x.kind}" style="flex-grow:${x.tokens};flex-basis:0" tabindex="0" data-tip="${esc(
          `<strong>${fmt(x.tokens)} tokens</strong><br>${x.label}`
        )}"></span>`
    )
    .join("");
  const pad =
    scale > total
      ? `<span class="seg-pad" style="flex-grow:${scale - total};flex-basis:0"></span>`
      : "";
  const legend = segs
    .filter((x) => x.tokens > 0)
    .map(
      (x) =>
        `<span class="seg-key"><span class="swatch ${x.kind}"></span>${fmt(x.tokens)} ${esc(x.label)}</span>`
    )
    .join("");
  return `<div class="ex-row"><div class="ex-title">${title}</div><div class="ex-bar">${parts}${pad}</div><div class="ex-legend">${legend}</div></div>`;
}

function example(heading: string, note: string, bars: string[]): string {
  return `<div class="ex"><h4>${heading}</h4>${bars.join("")}<p class="chart-note">${note}</p></div>`;
}

function tailExamples(): string {
  const ARGON = "gemini-4-argon";
  const out: string[] = [];
  const tail = (p: number, c: number) => p - c;

  // 1. An identical resend.
  const rep = csv("repeats").find(
    (r) =>
      r.model === ARGON &&
      r.words === "8000" &&
      r.ask === "short" &&
      r.send === "1" &&
      num(r.cached)! > 0
  );
  if (rep) {
    const p = num(rep.prompt)!;
    const c = num(rep.cached)!;
    out.push(
      example(
        "An identical resend",
        `The same ${fmt(p)}-token request sent a second time: everything but the last ${fmt(tail(p, c))} tokens is billed as cached.`,
        [
          bar(
            `Send 2 · ${fmt(p)} tokens`,
            [
              { tokens: c, kind: "cached", label: "billed as cached" },
              {
                tokens: p - c,
                kind: "full",
                label: "full price (the last 2,049)",
              },
            ],
            p
          ),
        ]
      )
    );
  }

  // 2 + 3. Either side of the minimum.
  const mins = csv("minimum").filter((r) => r.model === ARGON);
  const sends = mins.flatMap((r) =>
    (r.prompts_all ?? "").split(";").map((p, i) => ({
      prompt: Number(p),
      cached: Number((r.cached_all ?? "").split(";")[i]),
      anyHit: (num(r.cached_max) ?? 0) > 0,
    }))
  );
  const hit = sends
    .filter((x) => x.cached > 0)
    .sort((a, b) => a.prompt - b.prompt)[0];
  const miss = sends
    .filter((x) => !x.anyHit)
    .sort((a, b) => b.prompt - a.prompt)[0];
  if (hit && miss) {
    const scale = Math.max(hit.prompt, miss.prompt);
    out.push(
      example(
        "Either side of the minimum",
        `The largest request that never cached and the smallest that did. With 2,049 tokens always held back, ${fmt(miss.prompt)} tokens would leave only ${fmt(miss.prompt - 2049)} to cache, and argon cached nothing. ${fmt(hit.prompt)} tokens left ${fmt(hit.cached)}, and every request that size or larger cached. That fits a minimum of 2,048 cached tokens on top of the tail (4,096 ≈ 2,048 + 2,049), though the data only bracket it between ${fmt(miss.prompt - 2049 + 1)} and ${fmt(hit.cached)}.`,
        [
          bar(
            `${fmt(miss.prompt)} tokens · never cached`,
            [
              {
                tokens: miss.prompt,
                kind: "full",
                label: "full price (nothing cached)",
              },
            ],
            scale
          ),
          bar(
            `${fmt(hit.prompt)} tokens · cached`,
            [
              { tokens: hit.cached, kind: "cached", label: "billed as cached" },
              {
                tokens: hit.prompt - hit.cached,
                kind: "full",
                label: "full price (the last 2,049)",
              },
            ],
            scale
          ),
        ]
      )
    );
  }

  // 4. A very large request.
  const big = csv("tail").find(
    (r) => r.model === ARGON && r.variant === "large" && num(r.cached_2)! > 0
  );
  if (big) {
    const p = num(big.prompt_2)!;
    const c = num(big.cached_2)!;
    out.push(
      example(
        "A 128k-token request",
        `The same 2,049 tokens, now ${((100 * (p - c)) / p).toFixed(1)}% of the request. At the minimum size above, it was half.`,
        [
          bar(
            `Send 2 · ${fmt(p)} tokens`,
            [
              { tokens: c, kind: "cached", label: "billed as cached" },
              {
                tokens: p - c,
                kind: "full",
                label: "full price (the last 2,049)",
              },
            ],
            p
          ),
        ]
      )
    );
  }

  // 5 + 6. Threads: a short reply, then a long one.
  const ext = csv("extend").filter((r) => r.model === ARGON);
  const chainSteps = (chain: string) => {
    for (const rs of groupBy(
      ext.filter((r) => r.chain === chain),
      (r) => r.trial!
    ).values()) {
      rs.sort((a, b) => Number(a.step) - Number(b.step));
      if (rs.length >= 2 && num(rs[1]!.cached)! > 0) return rs;
    }
    return null;
  };
  const text = chainSteps("text_chain");
  if (text) {
    const p0 = num(text[0]!.prompt)!;
    const p1 = num(text[1]!.prompt)!;
    const c1 = num(text[1]!.cached)!;
    out.push(
      example(
        "The next request in a conversation",
        `Request 2 is request 1 plus the model’s one-word reply and a short new message (${fmt(p1 - p0)} tokens). It reuses request 1’s saved part, so it pays full price for request 1’s last ${fmt(p0 - c1)} tokens plus the ${fmt(p1 - p0)} new ones.`,
        [
          bar(
            `Request 1 · ${fmt(p0)} tokens`,
            [{ tokens: p0, kind: "full", label: "full price (first send)" }],
            p1
          ),
          bar(
            `Request 2 · ${fmt(p1)} tokens`,
            [
              { tokens: c1, kind: "cached", label: "billed as cached" },
              {
                tokens: p0 - c1,
                kind: "full",
                label: "full price (request 1’s last 2,049)",
              },
              {
                tokens: p1 - p0,
                kind: "new",
                label: "full price (new since request 1)",
              },
            ],
            p1
          ),
        ]
      )
    );
  }
  const para = chainSteps("para_chain");
  if (para) {
    const p0 = num(para[0]!.prompt)!;
    const o0 = num(para[0]!.output)!;
    const p1 = num(para[1]!.prompt)!;
    const c1 = num(para[1]!.cached)!;
    out.push(
      example(
        "After appending more than 2,049 tokens",
        `Request 1’s reply was ${fmt(o0)} tokens long, so request 2 appends more than 2,049 tokens. It reuses all of request 1’s prompt (${fmt(c1)} cached, one more than request 1’s ${fmt(p0)}), and pays full price only for the reply and the new message.`,
        [
          bar(
            `Request 1 · ${fmt(p0)} tokens`,
            [{ tokens: p0, kind: "full", label: "full price (first send)" }],
            p1
          ),
          bar(
            `Request 2 · ${fmt(p1)} tokens`,
            [
              { tokens: c1, kind: "cached", label: "billed as cached" },
              {
                tokens: p1 - c1,
                kind: "new",
                label: "full price (the reply and the new message)",
              },
            ],
            p1
          ),
        ]
      )
    );
  }

  return (
    `<figure class="chart examples"><figcaption>Real argon requests from this experiment</figcaption>` +
    `<div class="legend"><span class="legend-item"><span class="swatch cached"></span>billed as cached</span><span class="legend-item"><span class="swatch full"></span>full price</span><span class="legend-item"><span class="swatch new"></span>full price, new since the previous request</span></div>` +
    out.join("") +
    `<p class="chart-note">Each bar is one request, drawn to scale within its example. Numbers are <code>promptTokenCount</code> and <code>cachedContentTokenCount</code> from <code>results/repeats.csv</code>, <code>minimum.csv</code>, <code>tail.csv</code> and <code>extend.csv</code>, picked by the report script.</p></figure>`
  );
}

// ------------------------------------------------------------- two turns

/** The source of src/two-turns.ts, shown verbatim so the page can't drift. */
function twoTurnsCode(): string {
  const code = fs.readFileSync(path.join(root, "src", "two-turns.ts"), "utf8");
  return `<details class="table-view" open><summary><code>src/two-turns.ts</code>, the exact code behind both examples</summary><pre><code>${esc(code)}</code></pre></details>`;
}

function twoTurns(): string {
  // The 10,000-token opening only; smallTurns() shows the 4,100-token one.
  const rows = csv("two_turns").filter(
    (r) => (r.opening_words || "10000") === "10000"
  );
  const clean = (r: Row) =>
    num(r.prompt_2)! - num(r.counted_2)! < 300 &&
    num(r.prompt_1)! - num(r.counted_1)! < 300;
  const ARGON = "gemini-4-argon";
  const pick = (kind: string) =>
    rows.find(
      (r) =>
        r.model === ARGON &&
        r.kind === kind &&
        (kind !== "your_text" || r.append_words === "3000") &&
        clean(r) &&
        num(r.cached_2)! > 0
    );
  const bars: string[] = [];
  const a = pick("your_text");
  const b = pick("long_reply");
  const scale = Math.max(num(a?.prompt_2) ?? 0, num(b?.prompt_2) ?? 0);
  for (const [r, title, appended] of [
    [
      a,
      "A. You append 3,000 tokens",
      "your 3,000 tokens and the model’s one-word reply",
    ],
    [
      b,
      "B. The model replies with ~3,400 tokens",
      "the model’s reply and your short follow-up",
    ],
  ] as const) {
    if (!r) continue;
    const p1 = num(r.prompt_1)!;
    const p2 = num(r.prompt_2)!;
    const c2 = num(r.cached_2)!;
    bars.push(
      example(
        title,
        `Turn 2 is ${fmt(p2)} tokens. ${fmt(c2)} are billed as cached: all of turn 1’s ${fmt(p1)}-token prompt, plus one. Only ${fmt(p2 - c2)} are full price: ${appended}.`,
        [
          bar(
            `Turn 1 · ${fmt(p1)} tokens`,
            [{ tokens: p1, kind: "full", label: "full price (first send)" }],
            scale
          ),
          bar(
            `Turn 2 · ${fmt(p2)} tokens`,
            [
              { tokens: c2, kind: "cached", label: "billed as cached" },
              {
                tokens: p2 - c2,
                kind: "new",
                label: "full price (new since turn 1)",
              },
            ],
            scale
          ),
        ]
      )
    );
  }
  const figure =
    `<figure class="chart examples"><figcaption>Both conversations, turn 2 (argon)</figcaption>` +
    `<div class="legend"><span class="legend-item"><span class="swatch cached"></span>billed as cached</span><span class="legend-item"><span class="swatch full"></span>full price</span><span class="legend-item"><span class="swatch new"></span>full price, new since turn 1</span></div>` +
    bars.join("") +
    `</figure>`;

  // Every trial, grouped by how much was appended.
  const out: string[][] = [];
  for (const model of MODELS) {
    const groups = groupBy(
      rows.filter((r) => r.model === model),
      (r) =>
        r.kind === "long_reply" ? "long_reply" : `your_text:${r.append_words}`
    );
    const keys = [...groups.keys()].sort((x, y) => {
      const n = (k: string) =>
        k === "long_reply" ? 1e9 : Number(k.split(":")[1]);
      return n(x) - n(y);
    });
    for (const k of keys) {
      const rs = groups.get(k)!;
      const ok = rs.filter((r) => clean(r) && num(r.cached_2)! > NOISE);
      const appended = rs.map((r) => num(r.prompt_2)! - num(r.prompt_1)!);
      const relative = ok.map((r) => num(r.cached_2)! - num(r.prompt_1)!);
      const whole = relative.filter((x) => x >= -10).length;
      out.push([
        SHORT[model]!,
        k === "long_reply"
          ? "the model’s reply (~3,000–3,900)"
          : `your text (${fmt(Number(k.split(":")[1]))} words)`,
        range(appended),
        relative.length
          ? range(relative.map((x) => x)).replace(/^-/, "−")
          : "–",
        `${whole} / ${ok.length}`,
        String(rs.length - ok.length),
        String(rs.length),
      ]);
    }
  }
  const table1 = table(
    [
      "Model",
      "Appended",
      "Tokens appended",
      "Turn 2 cached − turn 1 prompt",
      "Reused all of turn 1",
      "Missed (hidden block or random)",
      "n",
    ],
    out,
    [2, 3, 4, 5, 6]
  );
  return (
    figure +
    twoTurnsCode() +
    `<h4>Where the edge is</h4>` +
    table1 +
    `<p class="chart-note">“Turn 2 cached − turn 1 prompt” is about −2,049 when turn 2 used turn 1’s shorter saved point, and +1 (argon) or −1 to −3 (3.1) when it used the end of turn 1.</p>` +
    source("run-two-turns.ts", "two_turns.csv", rows.length)
  );
}

// ----------------------------------------------------------- small turns

/** 4,100 tokens, then 1,000 or 2,100 more: what you'd expect vs what happens. */
function smallTurns(): string {
  const rows = csv("two_turns").filter((r) => r.opening_words === "4050");
  if (rows.length === 0) return "";
  const hidden = (r: Row) =>
    num(r.prompt_1)! - num(r.counted_1)! > 300 ||
    num(r.prompt_2)! - num(r.counted_2)! > 300;
  const ARGON = "gemini-4-argon";
  const parts: string[] = [];
  let scale = 0;
  const picks = ["1000", "2100"].map((a) =>
    rows.find(
      (r) =>
        r.model === ARGON &&
        r.append_words === a &&
        !hidden(r) &&
        num(r.cached_2)! > 0
    )
  );
  for (const r of picks) if (r) scale = Math.max(scale, num(r.prompt_2)!);
  for (const r of picks) {
    if (!r) continue;
    const p1 = num(r.prompt_1)!;
    const p2 = num(r.prompt_2)!;
    const c2 = num(r.cached_2)!;
    const added = p2 - p1;
    const usedEnd = c2 > p1 - 10;
    parts.push(
      example(
        `${fmt(p1)} tokens, then ${fmt(added)} more`,
        usedEnd
          ? `More than 2,049 tokens were appended, so turn 2 reuses the whole of turn 1 (${fmt(c2)} cached) and pays full price only for the ${fmt(p2 - c2)} new tokens. What you’d expect.`
          : `Less than 2,049 tokens were appended, so turn 2 can’t use the end of turn 1 (it is inside turn 2’s own last 2,049 tokens). It falls back to turn 1 minus 2,049: ${fmt(c2)} cached, and ${fmt(p2 - c2)} at full price, ${fmt(p1 - c2)} of them turn 1’s tail paid for a second time.`,
        [
          bar(
            `What you’d expect · turn 2, ${fmt(p2)} tokens`,
            [
              { tokens: p1, kind: "cached", label: "cached (all of turn 1)" },
              { tokens: added, kind: "new", label: "full price (new)" },
            ],
            scale
          ),
          bar(
            `What argon did · turn 2, ${fmt(p2)} tokens`,
            usedEnd
              ? [
                  { tokens: c2, kind: "cached", label: "billed as cached" },
                  { tokens: p2 - c2, kind: "new", label: "full price (new)" },
                ]
              : [
                  { tokens: c2, kind: "cached", label: "billed as cached" },
                  {
                    tokens: p1 - c2,
                    kind: "full",
                    label: "full price (turn 1’s last 2,049, again)",
                  },
                  { tokens: p2 - p1, kind: "new", label: "full price (new)" },
                ],
            scale
          ),
        ]
      )
    );
  }
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const a of ["1000", "2100"]) {
      const rs = rows.filter((r) => r.model === model && r.append_words === a);
      if (rs.length === 0) continue;
      const clean = rs.filter((r) => !hidden(r));
      const hits = clean.filter((r) => num(r.cached_2)! > NOISE);
      out.push([
        SHORT[model]!,
        `${fmt(Number(a))} words`,
        range(rs.map((r) => num(r.prompt_1)!)),
        range(rs.map((r) => num(r.prompt_2)!)),
        hits.length
          ? range(hits.map((r) => num(r.cached_2)!))
          : "0 (below 3.1’s threshold)",
        hits.length
          ? range(hits.map((r) => num(r.prompt_2)! - num(r.cached_2)!))
          : "everything",
        String(rs.length - clean.length),
        String(rs.length),
      ]);
    }
  }
  return (
    `<figure class="chart examples"><figcaption>A 4,100-token opening, then more (argon)</figcaption>` +
    `<div class="legend"><span class="legend-item"><span class="swatch cached"></span>billed as cached</span><span class="legend-item"><span class="swatch full"></span>full price, paid again</span><span class="legend-item"><span class="swatch new"></span>full price, new</span></div>` +
    parts.join("") +
    `</figure>` +
    table(
      [
        "Model",
        "Appended",
        "Turn 1",
        "Turn 2",
        "Turn 2 cached",
        "Turn 2 full price",
        "Hidden block (cached 0)",
        "n",
      ],
      out,
      [2, 3, 4, 5, 6, 7]
    ) +
    source("run-two-turns.ts", "two_turns.csv", rows.length)
  );
}

// ------------------------------------------------------------ exact 4100

/** The exact case on both providers: every trial, sizes checked. */
function exact4100(): string {
  const rows = csv("exact_4100");
  const out: string[][] = [];
  const cells = groupBy(rows, (r) => `${r.provider}|${r.turn1}|${r.append}`);
  for (const [key, rs] of [...cells.entries()].sort()) {
    const [provider, turn1, append] = key.split("|");
    const exact = rs.filter(
      (r) =>
        num(r.prompt_1) === Number(turn1) &&
        num(r.prompt_2) === Number(turn1) + Number(append)
    );
    const cached = [...new Set(exact.map((r) => num(r.cached_2)!))];
    out.push([
      provider === "openai"
        ? `OpenAI <code>${esc(rs[0]!.model)}</code>`
        : `Gemini <code>${esc(rs[0]!.model)}</code>`,
      fmt(Number(turn1)),
      fmt(Number(append)),
      cached.map(fmt).join(", ") || "–",
      cached.map((c) => fmt(Number(turn1) + Number(append) - c)).join(", ") ||
        "–",
      `${exact.length} / ${rs.length}`,
    ]);
  }
  return (
    table(
      [
        "Provider",
        "Turn 1",
        "Appended",
        "Turn 2 cached",
        "Turn 2 full price",
        "Exact-size trials / all",
      ],
      out,
      [1, 2, 3, 4, 5]
    ) +
    `<p class="chart-note">Only trials whose billed sizes came out exactly as asked are counted. The rest were Gemini requests blocked with <code>blockReason: OTHER</code> or carrying the hidden 697-token block.</p>` +
    source("run-exact-4100.ts", "exact_4100.csv", rows.length)
  );
}

// ---------------------------------------------------------- tail variants

function tailVariants(): string {
  const rows = csv("tail");
  const titles: Record<string, string> = {
    base: "baseline: filler words, one user message, thinking low",
    alnum: "random alphanumeric strings",
    json: "JSON records",
    thinking_high: "thinkingLevel high",
    thinking_default: "no thinkingConfig",
    system: "content in the system instruction",
    large: "~128k tokens",
  };
  const out: string[][] = [];
  for (const model of MODELS) {
    for (const variant of Object.keys(titles)) {
      const rs = rows.filter((r) => r.model === model && r.variant === variant);
      if (rs.length === 0) continue;
      const hits = rs.filter((r) => (num(r.cached_2) ?? 0) > 0);
      out.push([
        SHORT[model]!,
        titles[variant]!,
        range(rs.map((r) => num(r.prompt_2)!)),
        hits.length
          ? range(hits.map((r) => num(r.prompt_2)! - num(r.cached_2)!))
          : "not cached (below the threshold)",
        String(rs.length),
      ]);
    }
  }
  return (
    table(
      ["Model", "Variant", "Prompt", "Tail (prompt − cached)", "n"],
      out,
      [2, 3, 4]
    ) + source("run-tail.ts", "tail.csv", rows.length)
  );
}

// -------------------------------------------------------------- breakers

function breakers(): string {
  const rows = csv("breakers");
  const groups: Record<string, string> = {
    control: "Controls",
    content: "Content",
    tools: "Tools",
    thread: "Thread",
    generation: "Generation config",
    toolConfig: "toolConfig",
    other: "Other fields",
  };
  const hidden = (p?: string, c?: string) =>
    num(p) !== null && num(c) !== null ? num(p)! - num(c)! : 0;
  const out: string[] = [];
  for (const [group, title] of Object.entries(groups)) {
    const names = [
      ...new Set(rows.filter((r) => r.group === group).map((r) => r.variant!)),
    ];
    if (names.length === 0) continue;
    out.push(`<tr class="group-row"><td colspan="6">${esc(title)}</td></tr>`);
    for (const name of names) {
      const rs = rows.filter((r) => r.variant === name);
      const warm = rs.filter((r) => (num(r.base_cached) ?? 0) > 0);
      // argon's hidden block switched on or off between base and variant.
      const flipped = warm.filter(
        (r) =>
          Math.abs(
            hidden(r.prompt, r.counted) - hidden(r.base_prompt, r.base_counted)
          ) > 300
      );
      const clean = warm.filter((r) => !flipped.includes(r));
      const kept = clean.filter((r) => (num(r.cached) ?? 0) > NOISE).length;
      const lost = clean.length - kept;
      const outcome =
        clean.length === 0
          ? "–"
          : kept === clean.length
            ? "kept"
            : lost === clean.length
              ? "lost"
              : "mixed";
      const desc = BREAKER_DESCRIPTIONS[name] ?? "";
      out.push(
        `<tr><td><code>${esc(name)}</code><span class="var-name">${marked.parseInline(desc) as string}</span></td><td class="${outcome === "lost" ? "cmp-zero" : ""}">${outcome}</td><td class="num">${kept}</td><td class="num">${lost}</td><td class="num">${flipped.length}</td><td class="num">${rs.length}</td></tr>`
      );
    }
  }
  return (
    `<div class="table-scroll"><table class="compare"><thead><tr><th>Change</th><th>Outcome</th><th class="num">Kept the cache</th><th class="num">Lost it</th><th class="num">Hidden block switched</th><th class="num">n</th></tr></thead><tbody>${out.join("\n")}</tbody></table></div>` +
    `<p class="chart-note">“Kept” means the variant reported cached tokens (more than ${NOISE}). Trials whose base never cached, and trials where argon’s hidden block switched on or off between the base and the variant, are not counted as kept or lost.</p>` +
    source("run-breakers.ts", "breakers.csv", rows.length)
  );
}

// ------------------------------------------------------------------ page

const blog = fs.readFileSync(path.join(root, "blog.md"), "utf8");
const title = blog.match(/^# (.+)$/m)?.[1] ?? "gemini4_cache";
const blocks: Record<string, () => string> = {
  chains,
  threshold,
  tail,
  tailExamples,
  tailVariants,
  twoTurns,
  smallTurns,
  exact4100,
  edit,
  boundary,
  sig,
  inflation,
  breakers,
};
/** GitHub-style heading ids, so in-page links work the same as on GitHub. */
const slug = (h: string) =>
  h
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
const html = (marked.parse(blog) as string)
  .replace(
    /<h([23])>(.*?)<\/h\1>/g,
    (_, level: string, inner: string) =>
      `<h${level} id="${slug(inner)}">${inner}</h${level}>`
  )
  .replace(/<!-- report:(\w+) -->/g, (m, kind: string) =>
    blocks[kind] ? blocks[kind]() : m
  );
const total = [
  "minimum",
  "repeats",
  "tail",
  "extend",
  "edit",
  "boundary",
  "sig",
  "inflation",
  "breakers",
  "two_turns",
  "exact_4100",
].reduce((n, f) => n + csv(f).length, 0);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gemini 4 cache</title>
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
  --full: #898781;
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
    --full: #6b6a65;
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
  --full: #6b6a65;
  --code-bg: #262624;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; overflow-wrap: break-word; }
p code, li code { overflow-wrap: anywhere; }
td code { white-space: nowrap; }
h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { margin-top: 2.5rem; border-bottom: 1px solid var(--grid); padding-bottom: .3rem; }
h3 { margin-top: 1.8rem; }
h4 { margin: 1.2rem 0 .4rem; color: var(--ink-2); }
a { color: var(--series-1); }
code { font: .88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code-bg); padding: .1em .3em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 12px; border-radius: 8px; overflow-x: auto; }
pre code { padding: 0; background: none; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; }
.table-scroll, main > table { display: block; overflow-x: auto; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart { background: var(--surface); border: 1px solid var(--grid); border-radius: 10px; padding: 16px; margin: 1.5rem 0 .5rem; position: relative; }
.chart figcaption { font-weight: 600; margin-bottom: 12px; }
.chart-note { color: var(--ink-2); font-size: .85rem; margin: 8px 0 0; }
.bar-label { font-size: .82rem; overflow-wrap: anywhere; }
.bar-label code { background: none; padding: 0; }
.min-row { display: grid; grid-template-columns: minmax(96px, 22%) 1fr; gap: 10px; align-items: center; padding: 6px 0; }
.min-track { position: relative; height: 22px; border-bottom: 1px solid var(--axis); }
.min-dot { position: absolute; top: 5px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; outline: none; }
.min-dot::after { content: ""; position: absolute; inset: -6px; }
.min-dot.hit { background: var(--series-1); box-shadow: 0 0 0 2px var(--surface); }
.min-dot.miss { border: 2px solid var(--ink-2); background: var(--surface); }
.min-dot:focus-visible { box-shadow: 0 0 0 3px var(--ink-2); }
.min-rule { position: absolute; top: -4px; bottom: -4px; border-left: 2px dashed var(--ink-2); }
.min-ticks { position: relative; height: 16px; color: var(--muted); font-size: .72rem; }
.min-ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.min-ticks span:first-child { transform: none; }
.min-ticks span:last-child { transform: translateX(-100%); }
.group-row td { color: var(--ink-2); font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding-top: 14px; }
.var-name { display: block; color: var(--muted); font-size: .78rem; white-space: normal; }
.cmp-zero { font-weight: 600; }
.examples h4 { margin: 1.4rem 0 .6rem; color: var(--ink); font-size: .95rem; }
.examples .ex:first-of-type h4 { margin-top: .4rem; }
.ex-row { margin: 0 0 12px; }
.ex-title { font-size: .82rem; color: var(--ink-2); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.ex-bar { display: flex; gap: 2px; height: 22px; }
.seg { min-width: 3px; border-radius: 0; outline: none; }
.seg:first-child { border-radius: 4px 0 0 4px; }
.seg:last-of-type { border-radius: 0 4px 4px 0; }
.seg:only-of-type { border-radius: 4px; }
.seg:focus-visible { box-shadow: 0 0 0 2px var(--ink-2); }
.seg-pad { min-width: 0; }
.cached { background: var(--series-1); }
.full { background: var(--full); }
.new { background: repeating-linear-gradient(135deg, var(--full) 0 4px, var(--surface) 4px 6px); }
.ex-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 5px; font-size: .78rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.seg-key { display: inline-flex; align-items: center; gap: 6px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin: -4px 0 6px; font-size: .82rem; color: var(--ink-2); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 12px; height: 10px; border-radius: 2px; flex: none; }
.table-view { margin: .5rem 0 1.5rem; }
.table-view summary { cursor: pointer; color: var(--ink-2); font-size: .9rem; }
.tip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--axis); border-radius: 8px; padding: 8px 10px; font-size: .8rem; line-height: 1.45; max-width: 320px; box-shadow: 0 4px 16px rgb(0 0 0 / .15); display: none; }
</style>
</head>
<body>
<main>
${html}
<p class="chart-note">Generated by <code>scripts/build-report.ts</code> from <code>blog.md</code> and <code>results/*.csv</code> (${total} rows).</p>
</main>
<div class="tip" role="tooltip"></div>
<script>
const tip = document.querySelector(".tip");
function show(el, x, y) {
  tip.innerHTML = el.dataset.tip;
  tip.style.display = "block";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + "px";
  tip.style.top = (y + h + 20 > innerHeight ? y - h - 14 : y + 14) + "px";
}
for (const el of document.querySelectorAll("[data-tip]")) {
  el.addEventListener("mousemove", (e) => show(el, e.clientX, e.clientY));
  el.addEventListener("mouseleave", () => (tip.style.display = "none"));
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.bottom);
  });
  el.addEventListener("blur", () => (tip.style.display = "none"));
}
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, "index.html"), page);
console.log(`wrote index.html (${total} rows)`);
