// Claims about which earlier entries a request can reuse
// (scripts/run-boundary.ts).
import { describe, expect, it } from "@experiments/test";
import { runBoundary, type BoundaryVariant } from "../boundary.js";
import {
  ARGON,
  DELAY,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

type Trial = Awaited<ReturnType<typeof runBoundary>>;

const trial = (
  model: string,
  variant: BoundaryVariant,
  pre: (t: Trial) => boolean
) =>
  untilPrecondition(
    `boundary:${model}:${variant}`,
    3,
    (f) =>
      runBoundary({
        model,
        variant,
        preWords: 14000,
        postWords: 8000,
        delayMs: DELAY,
        ...f,
      }),
    (t) => !t.error && pre(t)
  );

const warmA = (t: Trial) => (t.a[1]?.cached ?? 0) > NOISE;

describe("reusing earlier requests", () => {
  it.each([ARGON, PRO])(
    "%s: with no shorter request sent before, editing the last message reuses nothing",
    async (model) => {
      const t = await trial(model, "cold", warmA);
      expect(warmA(t)).toBe(true);
      expect(t.edited!.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );

  it(
    "argon: editing the last message still reuses the whole earlier request that ended before it",
    async () => {
      const t = await trial(ARGON, "after_u1", warmA);
      expect(warmA(t)).toBe(true);
      // A request whose last message is edited still begins with the whole
      // earlier [u1] request, and reuses all of it (its prompt, plus one).
      expect(t.edited!.cached).toBeGreaterThanOrEqual(t.u1!.prompt);
      expect(t.edited!.cached).toBeLessThanOrEqual(t.u1!.prompt + 2);
    },
    TIMEOUT
  );

  it(
    "3.1: once a longer request has reused an entry, the shorter entry is gone",
    async () => {
      // Precondition: A's first send reused the [u1] entry.
      const t = await trial(
        PRO,
        "after_u1",
        (t) => (t.a[0]?.cached ?? 0) > NOISE
      );
      expect(t.a[0]!.cached).toBeGreaterThan(NOISE);
      expect(t.edited!.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s: an edit inside the first message reuses nothing",
    async (model) => {
      const t = await trial(model, "edit_u1", warmA);
      expect(warmA(t)).toBe(true);
      expect(t.edited!.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );
});
