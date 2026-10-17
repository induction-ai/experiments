// Claims about thought signatures and countTokens (scripts/run-sig.ts).
import { describe, expect, it } from "@experiments/test";
import { runSig, type SigTrial, type SigVariant } from "../sig.js";
import {
  ARGON,
  DELAY,
  NOISE,
  PRO,
  TIMEOUT,
  untilPrecondition,
} from "./helpers.js";

const trial = (
  model: string,
  variant: SigVariant,
  pre: (t: SigTrial) => boolean
) =>
  untilPrecondition(
    `sig:${model}:${variant}`,
    3,
    (f) =>
      runSig({
        model,
        variant,
        preWords: 18000,
        postWords: 5000,
        delayMs: DELAY,
        ...f,
      }),
    (t) => !t.error && pre(t)
  );

const warmA = (t: SigTrial) => (t.a[1]?.cached ?? 0) > NOISE;
/** argon added no hidden prompt tokens to C (see inflation.test.ts). */
const plainC = (t: SigTrial) => t.c[0]!.prompt - (t.ctC ?? 0) < 100;

describe("3.1 signatures", () => {
  it(
    "3.1: extending past a function call whose signature sits inside the stored span usually reuses nothing",
    async () => {
      // 6 of 7 trials in results/sig.csv lost everything, so assert a
      // majority of three warm trials rather than any single one.
      let lost = 0;
      for (let i = 0; i < 3; i++) {
        const t = await untilPrecondition(
          `sig:pro:usually:${i}`,
          3,
          (f) =>
            runSig({
              model: PRO,
              variant: "sig",
              preWords: 18000,
              postWords: 5000,
              delayMs: DELAY,
              ...f,
            }),
          (t) => !t.error && warmA(t)
        );
        expect(warmA(t)).toBe(true);
        expect(t.sigBytes).toBeGreaterThan(0);
        if (t.c[0]!.cached < NOISE) lost++;
      }
      expect(lost).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT
  );

  it(
    "3.1: without the signature, the same extension can keep the whole cache",
    async () => {
      const keeps = (t: SigTrial) =>
        warmA(t) && Math.abs(t.c[0]!.cached - t.a[1]!.cached) < 50;
      const t = await trial(PRO, "text", keeps);
      expect(keeps(t)).toBe(true);
    },
    TIMEOUT
  );

  it(
    "3.1: generateContent bills the signature only while it is the latest model turn; countTokens never does",
    async () => {
      const t = await trial(PRO, "sig", warmA);
      // A ends at the function call: its signature is billed...
      expect(t.a[0]!.prompt - t.ctA!).toBeGreaterThan(30);
      // ...countTokens ignores it...
      expect(t.ctA).toBe(t.ctANoSig);
      // ...and once the thread moves on, it is no longer billed, so the longer
      // thread bills fewer tokens than A did, exactly what countTokens says.
      expect(t.c[0]!.prompt).toBe(t.ctC);
      expect(t.c[0]!.prompt).toBeLessThan(t.a[0]!.prompt);
    },
    TIMEOUT
  );
});

describe("argon signatures", () => {
  it(
    "argon: extending past a function call reuses the whole earlier request",
    async () => {
      const t = await trial(ARGON, "sig", (t) => warmA(t) && plainC(t));
      expect(warmA(t) && plainC(t)).toBe(true);
      expect(t.c[0]!.cached).toBe(t.a[1]!.cached);
    },
    TIMEOUT
  );

  it(
    "argon: countTokens rejects a function call whose signature was removed",
    async () => {
      const t = await trial(ARGON, "sig", () => true);
      expect(t.ctANoSig).toBeNull();
      expect(t.ctError).toMatch(/thought_signature/);
      // With the signature kept, countTokens is within a few tokens of
      // what generateContent billed.
      expect(Math.abs(t.a[0]!.prompt - t.ctA!)).toBeLessThan(30);
    },
    TIMEOUT
  );
});
