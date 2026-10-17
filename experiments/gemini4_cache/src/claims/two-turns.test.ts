// Claims about the two-conversation example and where its edge is
// (scripts/run-two-turns.ts; the code is src/two-turns.ts).
import { describe, expect, it } from "@experiments/test";
import { twoTurns, type Kind } from "../two-turns.js";
import {
  ARGON,
  DELAY,
  fresh,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

type Result = Awaited<ReturnType<typeof twoTurns>>;

/** argon's hidden block is on neither turn, and turn 2 wasn't a random miss. */
const clean = (t: Result) =>
  t.turn1.prompt - t.turn1.counted < 300 &&
  t.turn2.prompt - t.turn2.counted < 300 &&
  t.turn2.cached > NOISE;

const run = (
  model: string,
  kind: Kind,
  appendWords?: number,
  openingWords?: number
) =>
  untilPrecondition(
    `two-turns:${model}:${kind}:${appendWords ?? ""}:${openingWords ?? ""}`,
    3,
    (f) =>
      twoTurns({
        model,
        kind,
        delayMs: DELAY,
        appendWords,
        openingWords,
        ...f,
      }),
    clean
  );

/** Turn 2 reused all of turn 1's prompt (argon +1, 3.1 within a few tokens). */
const reusedAll = (t: Result) =>
  t.turn2.cached >= t.turn1.prompt - 5 && t.turn2.cached <= t.turn1.prompt + 2;
/** Turn 2 reused turn 1's prompt minus the ~2,049 tail. */
const shortOfTail = (t: Result) => {
  const gap = t.turn1.prompt - t.turn2.cached;
  return gap >= 2030 && gap <= 2060;
};

describe("two conversations, same size", () => {
  it.each([ARGON, PRO])(
    "%s: appending 3,000 tokens of your own text reuses all of turn 1",
    async (model) => {
      const t = await run(model, "your_text", 3000);
      expect(clean(t)).toBe(true);
      expect(reusedAll(t)).toBe(true);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: a ~3,000-token reply plus a short follow-up reuses all of turn 1",
    async (model) => {
      const t = await run(model, "long_reply");
      expect(clean(t)).toBe(true);
      expect(t.turn1.output).toBeGreaterThan(2049);
      expect(reusedAll(t)).toBe(true);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: appending ~2,000 words (just under 2,049 tokens) falls 2,049 short of turn 1",
    async (model) => {
      const t = await run(model, "your_text", 2000);
      expect(t.turn2.prompt - t.turn1.prompt).toBeLessThan(2049);
      expect(shortOfTail(t)).toBe(true);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: appending ~2,100 words (just over 2,049 tokens) reuses all of turn 1",
    async (model) => {
      const t = await run(model, "your_text", 2100);
      expect(t.turn2.prompt - t.turn1.prompt).toBeGreaterThan(2049);
      expect(reusedAll(t)).toBe(true);
    },
    TIMEOUT
  );

  it(
    "argon: after a ~4,100-token turn 1, appending 1,000 tokens caches turn 1 minus 2,049, and the other ~3,076 are full price",
    async () => {
      const t = await run(ARGON, "your_text", 1000, 4050);
      expect(clean(t)).toBe(true);
      expect(t.turn1.prompt).toBeGreaterThan(4096);
      expect(t.turn2.cached).toBe(t.turn1.prompt - 2049);
      // Full price: turn 1's last 2,049 tokens again, plus everything new.
      expect(t.turn2.prompt - t.turn2.cached).toBe(
        2049 + (t.turn2.prompt - t.turn1.prompt)
      );
    },
    TIMEOUT
  );

  it(
    "argon: after a ~4,100-token turn 1, appending 2,100 tokens caches all of turn 1, and only the new tokens are full price",
    async () => {
      const t = await run(ARGON, "your_text", 2100, 4050);
      expect(clean(t)).toBe(true);
      expect(t.turn2.cached).toBe(t.turn1.prompt + 1);
      expect(t.turn2.prompt - t.turn2.cached).toBe(
        t.turn2.prompt - t.turn1.prompt - 1
      );
    },
    TIMEOUT
  );

  it(
    "3.1: a ~4,100-token turn 1 followed by 2,100 more caches nothing (below 3.1's threshold)",
    async () => {
      const t = await twoTurns({
        model: PRO,
        kind: "your_text",
        delayMs: DELAY,
        appendWords: 2100,
        openingWords: 4050,
        ...fresh("two-turns:pro:small"),
      });
      expect(t.turn2.cached).toBe(0);
    },
    TIMEOUT
  );
});
