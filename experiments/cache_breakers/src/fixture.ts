import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic, seeded prompt content. Nothing here comes from a real product:
// every section is filler drawn from a fixed vocabulary of common English
// words (roughly one token per word), so section sizes are predictable.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = (
  "river stone copper maple orbit lantern quiet harbor signal timber violet " +
  "garden window market silver engine forest winter candle bridge meadow " +
  "pocket thunder canvas rocket shadow marble falcon cotton island mirror " +
  "anchor basket feather planet ladder saddle helmet ribbon valley cabin " +
  "orange yellow purple simple gentle rapid narrow hollow steady golden " +
  "table paper field music story letter number circle square corner"
).split(" ");

export function words(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(VOCAB[Math.floor(rng() * VOCAB.length)]!);
  }
  return out.join(" ");
}

// Seeded slices of a public-domain novel (see data/README.md). Claude Opus 5's
// safety classifiers refused long runs of random words ("bio") and of
// grammar-generated sentences ("cyber"); real English text was accepted.
const BOOK_WORDS = fs
  .readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../data/pride-and-prejudice-ch1-20.txt"
    ),
    "utf8"
  )
  .split(/\s+/)
  .filter(Boolean);

export function book(rng: () => number, n: number): string {
  const start = Math.floor(rng() * (BOOK_WORDS.length - n));
  return BOOK_WORDS.slice(start, start + n).join(" ");
}

export type FillerStyle = "words" | "book";

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: "string"; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The provider-neutral content of a base request, in the sections whose
 * cache order we want to recover. Every section starts with the trial nonce
 * so no two trials share a prefix, whichever section a provider renders first.
 */
export interface Fixture {
  nonce: string;
  tools: ToolDef[];
  system: string;
  /** Two history exchanges: [user, assistant] early, then [user, assistant] late. */
  early: [Turn, Turn];
  late: [Turn, Turn];
  final: string;
  /** Spare content for variants that add a tool or a turn. */
  extraTool: ToolDef;
  extraTurn: string;
}

export const SECTIONS = ["tools", "system", "early", "late", "final"] as const;
export type Section = (typeof SECTIONS)[number];

export interface FixtureOptions {
  seed: number;
  nonce: string;
  /** Approximate token size of each of tools, system, early and late. */
  sectionWords: number;
  toolCount?: number;
  /** Filler for the large sections (default `words`). */
  style?: FillerStyle;
}

function makeTool(
  rng: () => number,
  i: number,
  descWords: number,
  lead = "",
  fill: (rng: () => number, n: number) => string = words
): ToolDef {
  const noun = words(rng, 1);
  return {
    name: `lookup_${noun}_${i}`,
    description: `${lead}${fill(rng, descWords)}`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: fill(rng, 6) },
        region: { type: "string", description: fill(rng, 6) },
      },
      required: ["query", "region"],
      additionalProperties: false,
    },
  };
}

export function buildFixture(opts: FixtureOptions): Fixture {
  const rng = mulberry32(opts.seed);
  const n = opts.sectionWords;
  const toolCount = opts.toolCount ?? 8;
  // Each tool carries ~40 tokens of schema framing; the rest is description.
  const descWords = Math.max(10, Math.floor(n / toolCount) - 40);
  const tag = `[${opts.nonce}] `;
  const fill = opts.style === "book" ? book : words;
  const tools = Array.from({ length: toolCount }, (_, i) =>
    makeTool(rng, i, descWords, i === 0 ? tag : "", fill)
  );
  const half = Math.floor(n / 2);
  return {
    nonce: opts.nonce,
    tools,
    system: `${tag}You are a terse assistant. ${fill(rng, n)}`,
    early: [
      { role: "user", text: `${tag}${fill(rng, half)}` },
      { role: "assistant", text: fill(rng, half) },
    ],
    late: [
      { role: "user", text: `${tag}${fill(rng, half)}` },
      { role: "assistant", text: fill(rng, half) },
    ],
    final: "Reply with the single word ok.",
    extraTool: makeTool(rng, toolCount, descWords, "", fill),
    extraTurn: fill(rng, 40),
  };
}

/** Replace the first character of a string so its first token changes. */
export function editStart(s: string): string {
  return `X${s.slice(1)}`;
}

/** Replace the word at `frac` (0–1) of the way through the string. */
export function editAt(s: string, frac: number): string {
  const w = s.split(" ");
  const i = Math.min(w.length - 1, Math.floor(frac * w.length));
  w[i] = "zebra";
  return w.join(" ");
}

/** Append a word so only the tail of the string changes. */
export function editEnd(s: string): string {
  return `${s} zebra`;
}
