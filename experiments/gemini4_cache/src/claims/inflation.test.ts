// Claims about argon's hidden prompt tokens (scripts/run-inflation.ts) and
// what they do to the cache (scripts/run-extend.ts, long_chain).
import { describe, expect, it } from "@experiments/test";
import { runExtend } from "../extend.js";
import { countTokens, generate } from "../gemini.js";
import { inflationRequest, runInflation } from "../inflation.js";
import {
  ARGON,
  DELAY,
  fresh,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

type Trial = Awaited<ReturnType<typeof runInflation>>;
const inflation = (t: Trial) => t.sends.map((s) => s.prompt - s.counted);

describe("argon’s hidden prompt tokens", () => {
  it(
    "argon bills a fixed hidden block of 697 tokens on some multi-message requests, which countTokens doesn't count, the same on every identical resend",
    async () => {
      // About a third of 8-message requests get the block (results/inflation.csv),
      // so look for one, then resend it unchanged.
      let found: { f: ReturnType<typeof fresh>; t: Trial } | null = null;
      const t = await untilPrecondition(
        "inflation:find",
        12,
        async (f) => {
          const t = await runInflation({
            model: ARGON,
            shape: "many_cold",
            words: 4000,
            system: "none",
            delayMs: DELAY,
            ...f,
          });
          found = { f, t };
          return t;
        },
        (t) => !t.error && inflation(t).some((d) => d > 300)
      );
      const sizes = inflation(t).filter((d) => d > 300);
      expect(sizes.length).toBeGreaterThan(0);
      for (const d of sizes) expect(d).toBe(697);
      // Resend the inflated request unchanged: same hidden block.
      const { f } = found!;
      const answer = inflation(t)[0]! > 300 ? "OK" : "YES";
      const req = inflationRequest(
        "many_cold",
        4000,
        f.seed,
        f.nonce,
        "none",
        answer
      );
      const again = await generate(ARGON, req);
      expect(again.usage!.prompt - (await countTokens(ARGON, req))).toBe(697);
    },
    TIMEOUT
  );

  it(
    "argon adds no hidden tokens to a single user message",
    async () => {
      for (let i = 0; i < 4; i++) {
        const t = await runInflation({
          model: ARGON,
          shape: "one",
          words: 4000,
          system: "none",
          delayMs: DELAY,
          ...fresh(`inflation:one:${i}`),
        });
        expect(inflation(t)).toEqual([0, 0]);
      }
    },
    TIMEOUT
  );

  it(
    "3.1 adds no hidden tokens where argon does",
    async () => {
      for (let i = 0; i < 4; i++) {
        const t = await runInflation({
          model: PRO,
          shape: "many_cold",
          words: 4000,
          system: "none",
          delayMs: DELAY,
          ...fresh(`inflation:pro:${i}`),
        });
        expect(inflation(t)).toEqual([0, 0]);
      }
    },
    TIMEOUT
  );

  it(
    "argon: when the next request of a thread gains the hidden block, it misses the cache entirely, and later requests reuse it again",
    async () => {
      const { steps, error } = await runExtend({
        model: ARGON,
        chain: "long_chain",
        words: 20000,
        steps: 4,
        delayMs: DELAY,
        ...fresh("inflation:chain"),
      });
      expect(error).toBeNull();
      const [, s1, s2, s3] = steps;
      // Step 2 appends ~28 tokens, but its prompt grows by ~725...
      expect(s2!.prompt - s1!.prompt).toBeGreaterThan(600);
      // ...and nothing is reused, though step 1 is a prefix of it.
      expect(s2!.cached).toBe(0);
      // Step 3 keeps the block and reuses step 2 as usual.
      expect(s3!.prompt - s2!.prompt).toBeLessThan(100);
      expect(s2!.prompt - s3!.cached).toBe(2049);
    },
    TIMEOUT
  );
});
