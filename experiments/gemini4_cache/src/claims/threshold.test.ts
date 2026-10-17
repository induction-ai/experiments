// Claims about where caching starts (scripts/run-minimum.ts).
import { describe, expect, it } from "@experiments/test";
import {
  runThreshold,
  SHAPES,
  type Shape,
  type ThresholdTrial,
} from "../threshold.js";
import { ARGON, DELAY, PRO, TIMEOUT, untilPrecondition } from "./helpers.js";

/** Filler is about one token per word; argon's hidden block adds ~700. */
const plain = (t: ThresholdTrial, words: number) =>
  !t.error && t.finals[0]!.prompt - words < 300;

const trial = (model: string, shape: Shape, words: number, repeats: number) =>
  untilPrecondition(
    `threshold:${model}:${shape}:${words}`,
    3,
    (f) =>
      runThreshold({
        model,
        shape,
        totalWords: words,
        repeats,
        delayMs: DELAY,
        ...f,
      }),
    (t) => plain(t, words)
  );

const anyHit = (t: ThresholdTrial) => t.finals.some((u) => u.cached > 0);

describe("argon’s threshold", () => {
  it.each(["one", "many_cold"] as const)(
    "argon %s: a request just under 4,096 prompt tokens is never cached",
    async (shape) => {
      // 3900 words: ~3950 tokens as one message, ~4040 as eight.
      const t = await trial(ARGON, shape, 3900, 3);
      expect(plain(t, 3900)).toBe(true);
      expect(t.finals[0]!.prompt).toBeLessThan(4096);
      expect(anyHit(t)).toBe(false);
    },
    TIMEOUT
  );

  it.each(["one", "many_cold"] as const)(
    "argon %s: a request just over 4,096 prompt tokens is cached from the second send",
    async (shape) => {
      // 4100 words: ~4150 tokens as one message, ~4240 as eight.
      const t = await trial(ARGON, shape, 4100, 2);
      expect(t.finals[0]!.prompt).toBeGreaterThan(4096);
      expect(t.finals[1]!.cached).toBe(t.finals[1]!.prompt - 2049);
    },
    TIMEOUT
  );
});

describe("3.1’s threshold", () => {
  it.each([...SHAPES])(
    "3.1 %s: a ~7,000-token request is not cached in four sends",
    async (shape) => {
      const t = await trial(PRO, shape, 7000, 4);
      expect(anyHit(t)).toBe(false);
    },
    TIMEOUT
  );

  it.each([...SHAPES])(
    "3.1 %s: a ~9,000-token request is cached from the second send",
    async (shape) => {
      const t = await trial(PRO, shape, 9000, 2);
      expect(t.finals[1]!.cached).toBeGreaterThan(6000);
    },
    TIMEOUT
  );
});
