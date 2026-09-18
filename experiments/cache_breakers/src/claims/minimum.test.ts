// Claims from blog.md § 1: the minimum cacheable size is 1024 tokens, for
// the whole prompt and for the header checkpoint alike.
// OpenAI Responses, gpt-5.6-sol.
import crypto from "node:crypto";
import { describe, expect, it, recordedValue } from "@experiments/test";
import { runMinimum, type MinimumProbe } from "../minimum.js";
import { adapter, LIVE, TIMEOUT } from "./helpers.js";

function probe(kind: MinimumProbe, words: number) {
  return runMinimum(adapter, kind, {
    model: adapter.defaultModel,
    words,
    seed: 77,
    nonce: recordedValue(`nonce:${kind}:${words}`, () =>
      crypto.randomBytes(6).toString("hex")
    ),
    maxCalls: 3,
    delayMs: LIVE ? 1500 : 0,
    historyWords: 1500,
  });
}

describe("minimum cacheable size", () => {
  it(
    "a whole prompt with fewer than 1024 cacheable tokens is never cached",
    async () => {
      const row = await probe("whole", 966);
      expect(row.error).toBe("");
      // The last 3 input tokens are never cached.
      expect(row.size_tokens! - 3).toBeLessThan(1024);
      expect(row.cached).toBe(0);
    },
    TIMEOUT
  );

  it(
    "a whole prompt with more than 1024 cacheable tokens is cached on repeat",
    async () => {
      const row = await probe("whole", 1006);
      expect(row.error).toBe("");
      expect(row.size_tokens! - 3).toBeGreaterThan(1024);
      expect(row.cached).toBe(row.size_tokens! - 3);
    },
    TIMEOUT
  );

  it(
    "a header under 1024 tokens is not reusable on its own, even in a large prompt",
    async () => {
      const row = await probe("header", 962);
      expect(row.error).toBe("");
      expect(row.cached).toBe(0);
    },
    TIMEOUT
  );

  it(
    "a header over 1024 tokens is reused when a later message changes",
    async () => {
      const row = await probe("header", 1006);
      expect(row.error).toBe("");
      expect(row.cached!).toBeGreaterThanOrEqual(1024);
    },
    TIMEOUT
  );
});
