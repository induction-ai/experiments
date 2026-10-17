// Claims about the exact case: a 4,100-token (or 4,000-token) request, then
// exactly 1,000 or 2,500 more tokens, on OpenAI and Gemini
// (scripts/run-exact-4100.ts; the code is src/exact-4100.ts).
import { describe, expect, it } from "@experiments/test";
import {
  branchCase,
  exactCase,
  gemini,
  openai,
  type BranchResult,
  type ExactResult,
} from "../exact-4100.js";
import { DELAY, TIMEOUT, untilPrecondition } from "./helpers.js";

type Outcome = ExactResult | { error: string };

/**
 * Run until a trial completes at exactly the requested sizes. Gemini
 * sometimes blocks turn 2 (`blockReason: OTHER`) or adds its hidden
 * 697-token block; neither says anything about where the cache resumes.
 */
const run = (name: "openai" | "gemini", turn1: number, append: number) =>
  untilPrecondition<Outcome>(
    `exact:${name}:${turn1}:${append}`,
    // Gemini blocks or inflates about half of these requests.
    12,
    async (f) => {
      const provider =
        name === "openai"
          ? openai("gpt-5.6-sol", f.nonce)
          : gemini("gemini-4-argon");
      try {
        return await exactCase({
          provider,
          turn1,
          append,
          delayMs: DELAY,
          ...f,
        });
      } catch (e) {
        return { error: String(e) };
      }
    },
    (t) =>
      !("error" in t) &&
      t.turn1.prompt === turn1 &&
      t.turn2.prompt === turn1 + append
  ) as Promise<ExactResult>;

describe("the exact 4,100-token case", () => {
  it.each([1000, 2500])(
    "OpenAI gpt-5.6-sol: after 4,100 tokens, +%i caches 4,097 and bills only the rest",
    async (append) => {
      const t = await run("openai", 4100, append);
      expect(t.turn1.prompt).toBe(4100);
      expect(t.turn2.prompt).toBe(4100 + append);
      expect(t.turn2.cached).toBe(4097);
    },
    TIMEOUT
  );

  it(
    "Gemini 4 argon: after 4,100 tokens, +1,000 caches 2,051 and bills 3,049",
    async () => {
      const t = await run("gemini", 4100, 1000);
      expect(t.turn2.prompt).toBe(5100);
      expect(t.turn2.cached).toBe(2051);
      expect(t.turn2.prompt - t.turn2.cached).toBe(3049);
    },
    TIMEOUT
  );

  it(
    "Gemini 4 argon: after 4,100 tokens, +2,500 caches 4,101 and bills 2,499",
    async () => {
      const t = await run("gemini", 4100, 2500);
      expect(t.turn2.prompt).toBe(6600);
      expect(t.turn2.cached).toBe(4101);
      expect(t.turn2.prompt - t.turn2.cached).toBe(2499);
    },
    TIMEOUT
  );

  it.each([1000, 2500])(
    "Gemini 4 argon: after 4,000 tokens, +%i caches nothing",
    async (append) => {
      const t = await run("gemini", 4000, append);
      expect(t.turn2.prompt).toBe(4000 + append);
      expect(t.turn2.cached).toBe(0);
    },
    TIMEOUT
  );

  const chain3 = (name: "openai" | "gemini", append: number, turn1 = 4100) =>
    untilPrecondition<Outcome>(
      `exact3:${name}:${turn1}:${append}`,
      // Gemini blocks most of these three-request chains (13 of 14 at 4,000).
      name === "gemini" ? 24 : 8,
      async (f) => {
        const provider =
          name === "openai"
            ? openai("gpt-5.6-sol", f.nonce)
            : gemini("gemini-4-argon");
        try {
          return await exactCase({
            provider,
            turn1,
            append,
            append3: 1500,
            delayMs: DELAY,
            ...f,
          });
        } catch (e) {
          return { error: String(e) };
        }
      },
      (t) => !("error" in t) && t.turn3?.prompt === turn1 + append + 1500
    ) as Promise<ExactResult>;

  it(
    "Gemini 4 argon: 4,100 → +1,000 → +1,500, turn 3 caches 3,051 (turn 2 − 2,049), not turn 1's end",
    async () => {
      const t = await chain3("gemini", 1000);
      expect(t.turn3!.prompt).toBe(6600);
      expect(t.turn3!.cached).toBe(3051);
    },
    TIMEOUT
  );

  it(
    "Gemini 4 argon: 4,100 → +2,500 → +1,500, turn 3 caches 4,551 (turn 2 − 2,049)",
    async () => {
      const t = await chain3("gemini", 2500);
      expect(t.turn3!.prompt).toBe(8100);
      expect(t.turn3!.cached).toBe(4551);
    },
    TIMEOUT
  );

  it(
    "Gemini 4 argon: 4,000 → +2,500 → +1,500, turn 2 caches nothing and turn 3 caches 4,451 (turn 2 − 2,049)",
    async () => {
      const t = await chain3("gemini", 2500, 4000);
      expect(t.turn2.cached).toBe(0);
      expect(t.turn3!.prompt).toBe(8000);
      expect(t.turn3!.cached).toBe(4451);
    },
    TIMEOUT
  );

  it.each([1000, 2500])(
    "OpenAI gpt-5.6-sol: 4,100 → +%i → +1,500, turn 3 resumes at turn 2's end minus 3",
    async (append) => {
      const t = await chain3("openai", append);
      expect(t.turn3!.cached).toBe(4100 + append - 3);
    },
    TIMEOUT
  );

  const branch = (name: "openai" | "gemini", sendTurn2: boolean) =>
    untilPrecondition<BranchResult | { error: string }>(
      `branch:${name}:${sendTurn2}`,
      name === "gemini" ? 16 : 6,
      async (f) => {
        const provider =
          name === "openai"
            ? openai("gpt-5.6-sol", f.nonce)
            : gemini("gemini-4-argon");
        try {
          return await branchCase({
            provider,
            append: 1000,
            branch: 2500,
            sendTurn2,
            delayMs: DELAY,
            ...f,
          });
        } catch (e) {
          return { error: String(e) };
        }
      },
      (t) => !("error" in t) && t.branch.prompt === 6600
    ) as Promise<BranchResult>;

  it(
    "Gemini 4 argon: a branch from turn 1 caches turn 1's end (4,101) if nothing else was sent",
    async () => {
      expect((await branch("gemini", false)).branch.cached).toBe(4101);
    },
    TIMEOUT
  );

  it(
    "Gemini 4 argon: once turn 2 (+1,000) was sent, the same branch caches only 3,051: turn 1's end breakpoint is gone",
    async () => {
      expect((await branch("gemini", true)).branch.cached).toBe(3051);
    },
    TIMEOUT
  );

  it.each([false, true])(
    "OpenAI branch, turn 2 sent = %s: the branch caches 4,097 either way (gpt-5.6-sol)",
    async (sendTurn2) => {
      expect((await branch("openai", sendTurn2)).branch.cached).toBe(4097);
    },
    TIMEOUT
  );
});
