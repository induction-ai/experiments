// Claims about real append-only threads (scripts/run-extend.ts).
import { describe, expect, it } from "@experiments/test";
import { runExtend, type Chain, type ExtendStep } from "../extend.js";
import {
  ARGON,
  DELAY,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

type Trial = Awaited<ReturnType<typeof runExtend>>;

/** Every step grew by about what it appended: argon added no hidden tokens. */
function plain(steps: ExtendStep[], appended: (k: number) => number): boolean {
  return steps.every(
    (s, k) => k === 0 || s.prompt - steps[k - 1]!.prompt < appended(k) + 300
  );
}

const chain = (
  model: string,
  c: Chain,
  steps: number,
  extra?: (t: Trial) => boolean
) =>
  untilPrecondition(
    `chain:${model}:${c}`,
    3,
    (f) =>
      runExtend({ model, chain: c, words: 20000, steps, delayMs: DELAY, ...f }),
    (t: Trial) =>
      !t.error &&
      t.steps.length === steps &&
      // Step 1 appends step 0's reply, which can be thousands of tokens.
      plain(t.steps, (k) => (k === 1 ? t.steps[0]!.output : 0)) &&
      (extra ? extra(t) : true)
  );

describe("append-only threads", () => {
  it.each([
    [ARGON, "text_chain"],
    [ARGON, "tool_chain"],
    [PRO, "text_chain"],
    [PRO, "tool_chain"],
  ] as const)(
    "%s %s: each request reuses the previous request, short of a ~2048-token tail (3.1 rarely misses one)",
    async (model, c) => {
      const t = await chain(model, c, 4);
      expect(t.error).toBeNull();
      let misses = 0;
      for (let k = 1; k < t.steps.length; k++) {
        if (t.steps[k]!.cached === 0) {
          misses++;
          continue;
        }
        const gap = t.steps[k - 1]!.prompt - t.steps[k]!.cached;
        expect(gap).toBeGreaterThanOrEqual(2030);
        expect(gap).toBeLessThanOrEqual(2080);
      }
      // argon hit every step in results/extend.csv; 3.1 missed 1 in 30.
      expect(misses).toBeLessThanOrEqual(model === ARGON ? 0 : 1);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: when less than ~2,049 tokens are appended (a short reply), the next request still falls ~2,049 short of the previous prompt",
    async (model) => {
      const t = await chain(
        model,
        "mid_chain",
        2,
        // A total miss (3.1's random misses, argon's hidden block) says nothing
        // about how much is reused, so it counts as a failed precondition.
        (t) => t.steps[0]!.output < 1900 && t.steps[1]!.cached > NOISE
      );
      const [s0, s1] = t.steps;
      expect(s0!.output).toBeLessThan(1900);
      const gap = s0!.prompt - s1!.cached;
      expect(gap).toBeGreaterThanOrEqual(2030);
      expect(gap).toBeLessThanOrEqual(2060);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: when more than ~2,049 tokens are appended (here a long reply), the next request reuses the whole previous prompt",
    async (model) => {
      const t = await chain(
        model,
        "para_chain",
        2,
        (t) => t.steps[0]!.output > 2200 && t.steps[1]!.cached > NOISE
      );
      const [s0, s1] = t.steps;
      expect(s0!.output).toBeGreaterThan(2200);
      expect(s1!.cached).toBeGreaterThanOrEqual(s0!.prompt - 10);
      expect(s1!.cached).toBeLessThanOrEqual(s0!.prompt + 2);
    },
    TIMEOUT
  );
});
