// Claims about editing a warm single message (scripts/run-edit.ts).
import { describe, expect, it } from "@experiments/test";
import { runEdit } from "../edit.js";
import {
  ARGON,
  DELAY,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

const warm = (t: Awaited<ReturnType<typeof runEdit>>) =>
  !t.error && (t.base[1]?.cached ?? 0) > NOISE;

describe("edits", () => {
  it(
    "3.1: an edit inside the stored span reuses nothing, an edit past it reuses the whole entry",
    async () => {
      const t = await untilPrecondition(
        "edit:pro",
        3,
        (f) =>
          runEdit({
            model: PRO,
            words: 20000,
            fracs: [0.5, 0.98],
            delayMs: DELAY,
            ...f,
          }),
        warm
      );
      expect(warm(t)).toBe(true);
      const [mid, late] = t.edits;
      expect(mid!.usage.cached).toBeLessThan(NOISE);
      expect(
        Math.abs(late!.usage.cached - t.base[1]!.cached)
      ).toBeLessThanOrEqual(5);
    },
    TIMEOUT
  );

  it(
    "argon, single message: an edit even 98% of the way in reuses nothing",
    async () => {
      const t = await untilPrecondition(
        "edit:argon",
        3,
        (f) =>
          runEdit({
            model: ARGON,
            words: 20000,
            fracs: [0.98],
            delayMs: DELAY,
            ...f,
          }),
        warm
      );
      expect(warm(t)).toBe(true);
      // The edit is past everything argon reported cached for the base...
      expect(0.98 * t.base[0]!.prompt).toBeGreaterThan(t.base[1]!.cached);
      // ...and still nothing is reused.
      expect(t.edits[0]!.usage.cached).toBeLessThan(NOISE);
    },
    TIMEOUT
  );

  it.each([ARGON, PRO])(
    "%s, split into two messages: an edit past the stored span keeps the whole entry",
    async (model) => {
      const t = await untilPrecondition(
        `edit:split:${model}`,
        3,
        (f) =>
          runEdit({
            model,
            words: 20000,
            fracs: [0.5, 0.98],
            shape: "split",
            delayMs: DELAY,
            ...f,
          }),
        warm
      );
      expect(warm(t)).toBe(true);
      const [mid, late] = t.edits;
      expect(mid!.usage.cached).toBeLessThan(NOISE);
      expect(
        Math.abs(late!.usage.cached - t.base[1]!.cached)
      ).toBeLessThanOrEqual(5);
    },
    TIMEOUT
  );
});
