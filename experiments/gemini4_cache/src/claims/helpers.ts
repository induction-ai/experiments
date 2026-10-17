// Shared setup for the claim tests. Each claim test runs the same probe the
// scripts use, live when recording and from committed recordings otherwise,
// so `pnpm test` re-checks every claim offline and `RECORD=true pnpm test`
// re-runs them against the API.
import crypto from "node:crypto";
import { recordedValue } from "@experiments/test";

export const ARGON = "gemini-4-argon";
export const PRO = "gemini-3.1-pro-preview";
/** Pause between calls on a live run (skipped on replay, see gemini.ts). */
export const DELAY = 3000;
export const TIMEOUT = 600_000;

export interface Fresh {
  seed: number;
  nonce: string;
}

/** A seed and nonce that are new on every recording and fixed on replay. */
export function fresh(key: string): Fresh {
  return {
    nonce: recordedValue(`nonce:${key}`, () =>
      crypto.randomBytes(6).toString("hex")
    ),
    seed: Number(
      recordedValue(`seed:${key}`, () => String(crypto.randomInt(1, 2 ** 31)))
    ),
  };
}

/**
 * Run a trial up to `tries` times with fresh content until `precondition`
 * holds, e.g. "the base request was cached" or "argon added no hidden
 * tokens". The precondition is never the claim itself: the caller asserts
 * the claim on the trial that met it. Replays stop at the same attempt.
 */
export async function untilPrecondition<T>(
  key: string,
  tries: number,
  run: (f: Fresh) => Promise<T>,
  precondition: (t: T) => boolean
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await run(fresh(`${key}:${i}`));
    if (precondition(last)) return last;
  }
  return last!;
}

/** Reported cached counts below this are shared-header noise, not a reuse. */
export const NOISE = 200;
