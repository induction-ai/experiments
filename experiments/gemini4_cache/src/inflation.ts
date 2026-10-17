// The inflation probe: which requests does gemini-4-argon bill hidden extra
// prompt tokens for? countTokens never includes them, so the inflation of a
// request is generateContent's promptTokenCount minus countTokens of the same
// request (normally within a few tokens).
//
// Per trial: one request of `words` filler words in the given shape (1, 2 or
// 8 messages; see threshold.ts), optionally under a short system instruction.
// It is sent once, then a copy whose final question differs by one word is
// sent once, and both are counted with countTokens, so a trial shows the
// inflation and whether a one-word change to the end flips it.
import {
  countTokens,
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Request,
} from "./gemini.js";
import { chunks, type Shape } from "./threshold.js";

export const INFLATION_SHAPES = ["one", "two_cold", "many_cold"] as const;
export const SYSTEMS = ["none", "short"] as const;
export type System = (typeof SYSTEMS)[number];

const SYSTEM_TEXT = "You are a careful assistant. Answer briefly.";

export function inflationRequest(
  shape: Shape,
  words: number,
  seed: number,
  nonce: string,
  system: System,
  answer: "OK" | "YES"
): Request {
  const c = chunks(shape, words, seed, nonce);
  const question = `Reply with the single word ${answer}.`;
  const contents: Content[] =
    c.at(-1)!.role === "user"
      ? [
          ...c.slice(0, -1),
          { role: "user", parts: [...c.at(-1)!.parts, { text: question }] },
        ]
      : [...c, { role: "user", parts: [{ text: question }] }];
  return {
    ...(system === "short"
      ? { systemInstruction: { parts: [{ text: SYSTEM_TEXT }] } }
      : {}),
    contents,
    generationConfig: GENERATION_CONFIG,
  };
}

export interface InflationSend {
  prompt: number;
  counted: number;
  cached: number;
}

export async function runInflation(opts: {
  model: string;
  shape: Shape;
  words: number;
  system: System;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<{ sends: InflationSend[]; error: string | null }> {
  const sends: InflationSend[] = [];
  for (const answer of ["OK", "YES"] as const) {
    const req = inflationRequest(
      opts.shape,
      opts.words,
      opts.seed,
      opts.nonce,
      opts.system,
      answer
    );
    const r = await generate(opts.model, req);
    if (!r.usage) return { sends, error: r.error };
    const counted = await countTokens(opts.model, req);
    sends.push({ prompt: r.usage.prompt, counted, cached: r.usage.cached });
    await sleep(opts.delayMs);
  }
  return { sends, error: null };
}
