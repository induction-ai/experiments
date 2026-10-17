// The tail probe: is the uncached tail of an identical repeat a fixed number
// of tokens, or does it depend on what the request contains or how it is
// configured? One factor changes at a time from a baseline (`base`: filler
// words in one user message, thinkingLevel low, ~8000 tokens).
//
// Per trial the same request is sent twice; tail = prompt − cached on the
// second send.
import { mulberry32, words } from "./filler.js";
import {
  generate,
  GENERATION_CONFIG,
  sleep,
  type Json,
  type Request,
} from "./gemini.js";

export const TAIL_VARIANTS = [
  "base",
  "alnum",
  "json",
  "thinking_high",
  "thinking_default",
  "system",
  "large",
] as const;
export type TailVariant = (typeof TAIL_VARIANTS)[number];

const QUESTION = "Reply with the single word OK.";

/** Random alphanumeric strings: several tokens each, unlike the filler words. */
export function alnum(seed: number, n: number): string {
  const rng = mulberry32(seed);
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = "";
    const len = 4 + Math.floor(rng() * 6);
    for (let j = 0; j < len; j++) w += chars[Math.floor(rng() * chars.length)];
    out.push(w);
  }
  return out.join(" ");
}

/** JSON records built from the filler vocabulary. */
export function jsonRecords(seed: number, n: number): string {
  const rng = mulberry32(seed);
  const recs: Json[] = [];
  for (let i = 0; i < n; i++) {
    recs.push({
      id: i,
      name: words(rng, 2),
      tags: words(rng, 3).split(" "),
      n: Math.floor(rng() * 1e4),
    });
  }
  return JSON.stringify(recs);
}

/** Approximate unit counts that land near the target token size. */
export function body(
  variant: TailVariant,
  seed: number,
  tokens: number
): string {
  if (variant === "alnum") return alnum(seed, Math.round(tokens / 4.3));
  if (variant === "json") return jsonRecords(seed, Math.round(tokens / 22));
  return words(mulberry32(seed), tokens);
}

export function tailRequest(
  variant: TailVariant,
  seed: number,
  nonce: string,
  tokens: number
): Request {
  const text = `Reference ${nonce}.\n${body(variant, seed, tokens)}`;
  const generationConfig: Json =
    variant === "thinking_high"
      ? { ...GENERATION_CONFIG, thinkingConfig: { thinkingLevel: "high" } }
      : variant === "thinking_default"
        ? { maxOutputTokens: GENERATION_CONFIG.maxOutputTokens }
        : GENERATION_CONFIG;
  if (variant === "system") {
    return {
      systemInstruction: { parts: [{ text }] },
      contents: [{ role: "user", parts: [{ text: QUESTION }] }],
      generationConfig,
    };
  }
  return {
    contents: [{ role: "user", parts: [{ text: `${text}\n\n${QUESTION}` }] }],
    generationConfig,
  };
}

export async function runTail(opts: {
  model: string;
  variant: TailVariant;
  tokens: number;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<{ prompts: number[]; cached: number[]; error: string | null }> {
  const req = tailRequest(opts.variant, opts.seed, opts.nonce, opts.tokens);
  const prompts: number[] = [];
  const cached: number[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await generate(opts.model, req);
    if (!r.usage) return { prompts, cached, error: r.error };
    prompts.push(r.usage.prompt);
    cached.push(r.usage.cached);
    if (i === 0) await sleep(opts.delayMs);
  }
  return { prompts, cached, error: null };
}
