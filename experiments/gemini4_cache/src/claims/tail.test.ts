// Claims about how much of a repeated request is cached
// (scripts/run-repeats.ts).
import { describe, expect, it } from "@experiments/test";
import { GENERATION_CONFIG } from "../gemini.js";
import { runTail } from "../tail.js";
import { runThreshold } from "../threshold.js";
import {
  ARGON,
  DELAY,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

const repeat = (model: string, words: number, key: string, ask?: "long") =>
  untilPrecondition(
    `tail:${model}:${words}:${key}`,
    3,
    (f) =>
      runThreshold({
        model,
        shape: "one",
        totalWords: words,
        repeats: 2,
        delayMs: DELAY,
        ...(ask === "long"
          ? {
              question:
                "Write a story of about 3000 words that uses as many of the words above as you can.",
              generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 8192 },
            }
          : {}),
        ...f,
      }),
    (t) => !t.error && (t.finals[1]?.cached ?? 0) > NOISE
  );

describe("the held-back tail", () => {
  it.each([8000, 32000])(
    "argon: an identical repeat of a %i-word message caches all but the last 2049 tokens",
    async (words) => {
      const t = await repeat(ARGON, words, "short");
      expect(t.finals[1]!.prompt - t.finals[1]!.cached).toBe(2049);
    },
    TIMEOUT
  );

  it(
    "3.1: an identical repeat caches all but about the last 2048 tokens",
    async () => {
      const t = await repeat(PRO, 32000, "short");
      const gap = t.finals[1]!.prompt - t.finals[1]!.cached;
      expect(gap).toBeGreaterThanOrEqual(2030);
      expect(gap).toBeLessThanOrEqual(2060);
    },
    TIMEOUT
  );

  it(
    "argon: a long reply doesn't shrink the held-back tail of an identical repeat",
    async () => {
      const t = await repeat(ARGON, 20000, "long", "long");
      expect(t.finals[0]!.output).toBeGreaterThan(2049);
      expect(t.finals[1]!.prompt - t.finals[1]!.cached).toBe(2049);
    },
    TIMEOUT
  );

  it.each([
    "alnum",
    "json",
    "thinking_high",
    "thinking_default",
    "system",
    "large",
  ] as const)(
    "argon: the tail of an identical repeat is 2049 tokens with variant %s",
    async (variant) => {
      const t = await untilPrecondition(
        `tail:variant:${variant}`,
        3,
        (f) =>
          runTail({
            model: ARGON,
            variant,
            tokens: variant === "large" ? 128000 : 8000,
            delayMs: DELAY,
            ...f,
          }),
        (t) => !t.error && (t.cached[1] ?? 0) > NOISE
      );
      expect(t.prompts[1]! - t.cached[1]!).toBe(2049);
    },
    TIMEOUT
  );

  it(
    "argon: the cached count grows one-for-one with the prompt, not in blocks from the start",
    async () => {
      // Two prompts a few dozen tokens apart: a block cache would report the
      // same cached count for both; argon's differs by exactly the prompt difference.
      const a = await repeat(ARGON, 4100, "blockA");
      const b = await repeat(ARGON, 4130, "blockB");
      const dp = b.finals[1]!.prompt - a.finals[1]!.prompt;
      const dc = b.finals[1]!.cached - a.finals[1]!.cached;
      expect(dp).toBeGreaterThan(0);
      expect(dc).toBe(dp);
    },
    TIMEOUT
  );
});
