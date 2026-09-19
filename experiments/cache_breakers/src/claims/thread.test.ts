// Claims about real multi-turn threads, where every earlier turn was sent:
// an edit or branch mid-thread keeps everything up to the end of the last
// earlier turn it still contains, on both APIs. Not further (into the
// following assistant reply) and not less.
import crypto from "node:crypto";
import { describe, expect, it, recordedValue } from "@experiments/test";
import {
  anthropicAuto,
  anthropicBreakpoints,
} from "../providers/anthropic-messages.js";
import { openaiResponses } from "../providers/openai-responses.js";
import type { Adapter } from "../providers/types.js";
import { runThread, type ThreadProbe } from "../thread.js";
import { LIVE, TIMEOUT } from "./helpers.js";

async function thread(adapter: Adapter, probe: ThreadProbe) {
  const row = await runThread(adapter, probe, {
    model: adapter.defaultModel,
    seed: 4321,
    nonce: recordedValue(`nonce:thread:${adapter.name}:${probe}`, () =>
      crypto.randomBytes(6).toString("hex")
    ),
    turns: 6,
    userWords: 150,
    replyWords: 500,
    delayMs: LIVE ? 1500 : 0,
  });
  expect(row.error).toBe("");
  return row;
}

/** Each turn read all of the previous one, so every turn left a checkpoint. */
function expectThreadGrew(requestCached: string) {
  const reads = requestCached.split(";").map(Number);
  expect(reads[0]).toBe(0);
  for (let i = 1; i < reads.length; i++) {
    expect(reads[i]!).toBeGreaterThan(reads[i - 1]!);
  }
}

describe.each([
  ["OpenAI Responses", openaiResponses],
  ["Anthropic automatic caching", anthropicAuto],
  ["Anthropic explicit breakpoints", anthropicBreakpoints],
])("%s, 6-turn thread", (_label, adapter) => {
  it.each([
    ["edit_u4", "editing user message 4"],
    ["branch_at_u4", "branching the thread at turn 4"],
    [
      "truncate_after_a4",
      "cutting the thread after reply 4 and asking something new",
    ],
    ["edit_a4", "appending a word to reply 4"],
  ])(
    "%s: %s keeps exactly up to the end of the last intact earlier turn",
    async (probe) => {
      const row = await thread(adapter, probe as ThreadProbe);
      expectThreadGrew(row.request_cached);
      // The baseline: the plain next turn (request 6) read all of request 5.
      const reads = row.request_cached.split(";").map(Number);
      const sizes = row.request_tokens.split(";").map(Number);
      expect(Math.abs(reads[5]! - (sizes[4]! - 3))).toBeLessThanOrEqual(8);
      // Reuse reaches the previous turn's end exactly...
      expect(
        Math.abs(row.probe_cached! - row.predict_request_end!)
      ).toBeLessThanOrEqual(8);
      // ...and not into the unchanged assistant reply that follows it.
      expect(row.probe_cached!).toBeLessThan(row.next_request_end! - 200);
    },
    TIMEOUT
  );
});
