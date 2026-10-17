// The threshold probe: does a request cache, given its total size and the
// shape of the history that led to it?
//
// Every shape ends in the same final request: T words of filler split across
// some number of messages, then a short user question. Shapes differ in how
// many messages carry the filler and in whether earlier prefixes of the
// thread were sent first (a conversation that grew turn by turn) or the final
// request arrives cold.
import { filler } from "./filler.js";
import {
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Json,
  type Request,
  type Usage,
} from "./gemini.js";

export const SHAPES = [
  "one",
  "two_cold",
  "two_grown",
  "many_cold",
  "many_grown",
] as const;
export type Shape = (typeof SHAPES)[number];

/** Filler messages in the `many_*` shapes. */
export const MANY = 8;

export const QUESTION = "Reply with the single word OK.";

export function pieces(shape: Shape): number {
  if (shape === "one") return 1;
  if (shape.startsWith("two")) return 2;
  return MANY;
}

/**
 * The filler messages, alternating user/model starting with user. Each piece
 * has its own seed so pieces differ; only the first carries the nonce, which
 * is enough to make the whole thread unique.
 */
export function chunks(
  shape: Shape,
  totalWords: number,
  seed: number,
  nonce: string
): Content[] {
  const n = pieces(shape);
  const per = Math.round(totalWords / n);
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "model",
    parts: [
      {
        text:
          i === 0
            ? filler(seed, nonce, per)
            : filler(seed + i, `part ${i + 1}`, per),
      },
    ],
  }));
}

function request(contents: Content[]): Request {
  return { contents, generationConfig: GENERATION_CONFIG };
}

/**
 * The requests to send, in order. The last one is the final request; the ones
 * before it (for `*_grown`) are the thread's earlier turns, each ending at a
 * user message the way a real client's earlier requests would.
 */
export function plan(
  shape: Shape,
  totalWords: number,
  seed: number,
  nonce: string,
  question = QUESTION,
  generationConfig: Json = GENERATION_CONFIG
): { warmups: Request[]; final: Request } {
  const c = chunks(shape, totalWords, seed, nonce);
  const final = {
    ...request(withQuestion(c, question)),
    generationConfig,
  };
  if (!shape.endsWith("_grown")) return { warmups: [], final };
  const warmups: Request[] = [];
  for (let i = 0; i < c.length; i++) {
    if (c[i]!.role === "user") warmups.push(request(c.slice(0, i + 1)));
  }
  return { warmups, final };
}

function withQuestion(c: Content[], question: string): Content[] {
  const last = c[c.length - 1]!;
  // Two user turns in a row are allowed, but appending to the last user
  // piece keeps the strict alternation every real client sends.
  if (last.role === "user") {
    return [
      ...c.slice(0, -1),
      { role: "user", parts: [...last.parts, { text: question }] },
    ];
  }
  return [...c, { role: "user", parts: [{ text: question }] }];
}

export interface ThresholdTrial {
  warmupPrompts: number[];
  finals: Usage[];
  /** `modelVersion` of every call, warm-ups first. */
  versions: string[];
  error: string | null;
}

/**
 * Send the warm-ups once each, then the final request `repeats` times,
 * pausing `delayMs` between calls so a cache write has time to land.
 */
export async function runThreshold(opts: {
  model: string;
  shape: Shape;
  totalWords: number;
  seed: number;
  nonce: string;
  repeats: number;
  delayMs: number;
  question?: string;
  generationConfig?: Json;
}): Promise<ThresholdTrial> {
  const { warmups, final } = plan(
    opts.shape,
    opts.totalWords,
    opts.seed,
    opts.nonce,
    opts.question,
    opts.generationConfig
  );
  const warmupPrompts: number[] = [];
  const versions: string[] = [];
  for (const w of warmups) {
    const r = await generate(opts.model, w);
    if (!r.usage)
      return { warmupPrompts, finals: [], versions, error: r.error };
    warmupPrompts.push(r.usage.prompt);
    versions.push(r.modelVersion ?? "");
    await sleep(opts.delayMs);
  }
  const finals: Usage[] = [];
  for (let i = 0; i < opts.repeats; i++) {
    const r = await generate(opts.model, final);
    if (!r.usage) return { warmupPrompts, finals, versions, error: r.error };
    finals.push(r.usage);
    versions.push(r.modelVersion ?? "");
    if (i < opts.repeats - 1) await sleep(opts.delayMs);
  }
  return { warmupPrompts, finals, versions, error: null };
}
