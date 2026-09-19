// Claims about OpenAI Responses on gpt-5.5, which reuses prefixes at fixed
// points (every 2048 tokens here) instead of whole messages like
// gpt-5.6-sol. About 5% of gpt-5.5 requests miss the cache entirely at
// random (see results/static/openai_responses_gpt-5.5.csv), so a claim that
// something is kept retries once on a total miss.
import crypto from "node:crypto";
import { describe, expect, it, recordedValue } from "@experiments/test";
import { openaiResponses55 } from "../providers/openai-responses.js";
import { runThread, type ThreadProbe, type ThreadRow } from "../thread.js";
import type { TrialRow } from "../trial.js";
import {
  expectClean,
  expectFull,
  expectZero,
  LIVE,
  TIMEOUT,
  trial,
} from "./helpers.js";

const g55 = (name: string) => trial(name, { adapter: openaiResponses55 });

/** Run a trial, and once more if the variant missed the cache entirely. */
async function kept(name: string): Promise<TrialRow> {
  const row = await g55(name);
  if (row.cached !== 0) return row;
  return trial(name, {
    adapter: openaiResponses55,
    seed: 1235,
    attempt: "retry",
  });
}

/** A 6-turn thread probe, retried once (fresh nonce) on a total miss. */
async function thread(probe: ThreadProbe): Promise<ThreadRow> {
  for (const attempt of ["first", "retry"]) {
    const row = await runThread(openaiResponses55, probe, {
      model: openaiResponses55.defaultModel,
      seed: 4321,
      nonce: recordedValue(`nonce:thread:gpt-5.5:${probe}:${attempt}`, () =>
        crypto.randomBytes(6).toString("hex")
      ),
      turns: 6,
      userWords: 150,
      replyWords: 500,
      delayMs: LIVE ? 1500 : 0,
    });
    expect(row.error).toBe("");
    if (row.probe_cached !== 0) {
      // The baseline next turn (request 6) stops at a block point, short of
      // request 5's end: the tail after it bills at full price.
      const reads = row.request_cached.split(";").map(Number);
      const sizes = row.request_tokens.split(";").map(Number);
      if (reads[5]! > 0) {
        expect((reads[5]! - 512) % 1024).toBe(0);
        expect(reads[5]!).toBeLessThan(sizes[4]! - 3);
      }
      return row;
    }
  }
  throw new Error(`${probe}: missed the cache twice`);
}

describe("OpenAI Responses, gpt-5.5, 6-turn thread", () => {
  it.each([
    ["edit_u4", "editing user message 4"],
    ["branch_at_u4", "branching at turn 4"],
  ])(
    "%s: %s lands on a block point, never past the previous turn's end",
    async (probe) => {
      const row = await thread(probe as ThreadProbe);
      // Usually a block short of it (14 of 15 trials in the CSV); equal when
      // the shared prefix happens to reach the next block point.
      expect(row.probe_cached!).toBeLessThanOrEqual(row.predict_request_end!);
      expect((row.probe_cached! - 512) % 1024).toBe(0);
    },
    TIMEOUT
  );

  it(
    "edit_a4: appending a word to reply 4 lands on a block point, never past the edit",
    async () => {
      const row = await thread("edit_a4");
      expect((row.probe_cached! - 512) % 1024).toBe(0);
      // Request 5's size minus user message 5 bounds where reply 4 ends; the
      // edit is at that end, so reuse must stop before request 5's end.
      const sizes = row.request_tokens.split(";").map(Number);
      expect(row.probe_cached!).toBeLessThan(sizes[4]! - 3);
    },
    TIMEOUT
  );

  it(
    "truncate_after_a4: cutting after reply 4 keeps past the previous turn's end, into reply 4",
    async () => {
      const row = await thread("truncate_after_a4");
      expect(row.probe_cached!).toBeGreaterThan(row.predict_request_end!);
      expect((row.probe_cached! - 512) % 1024).toBe(0);
    },
    TIMEOUT
  );
});

describe("OpenAI Responses, gpt-5.5", () => {
  it(
    "an edit late in the instructions keeps a block that ends inside them",
    async () => {
      const early = await g55("sweep_system_30");
      const late = await kept("sweep_system_80");
      expectZero(early);
      expectClean(late);
      // Reuse stops partway through the edited block, at a multiple of 512:
      // impossible under gpt-5.6-sol's whole-message matching.
      expect(late.cached!).toBeGreaterThan(0);
      expect(late.cached! % 512).toBe(0);
      expect(late.cached!).toBeLessThan(late.base_cached!);
    },
    TIMEOUT
  );

  it(
    "an edit in the late history keeps more than one in the early history",
    async () => {
      const early = await kept("early_edit_start");
      const late = await kept("late_edit_end");
      for (const r of [early, late]) {
        expectClean(r);
        expect(r.cached! % 512).toBe(0);
      }
      expect(late.cached!).toBeGreaterThan(early.cached!);
    },
    TIMEOUT
  );

  it.each([
    ["tool_add", "adding a tool"],
    ["model_switch", "switching to gpt-5.4"],
    ["effort_medium", "reasoning effort low → medium"],
    ["json_schema_format", "a text.format JSON schema"],
    ["verbosity_high", "text.verbosity: high"],
    ["cache_key_changed", "a different prompt_cache_key"],
  ])(
    "%s: %s reuses nothing, as on gpt-5.6-sol",
    async (name) => {
      expectZero(await g55(name));
    },
    TIMEOUT
  );

  it(
    "omitting reasoning is the same as medium: full reuse after medium",
    async () => {
      const row = await kept("effort_medium_omitted");
      expectFull(row);
    },
    TIMEOUT
  );

  it(
    "tool_choice: required bills a small tail uncached and writes nothing",
    async () => {
      const row = await kept("tool_choice_required");
      expectClean(row);
      expect(row.input).toBe(row.base_input);
      expect(row.cache_write).toBe(0);
      const lost = row.base_cached! - row.cached!;
      expect(lost).toBeGreaterThan(0);
      expect(lost).toBeLessThanOrEqual(256);
    },
    TIMEOUT
  );

  it(
    "the max effort level is rejected on gpt-5.5",
    async () => {
      const row = await g55("effort_low_to_max");
      expect(row.warmed).toBe(true);
      expect(row.error).toMatch(/'max' is not supported/);
    },
    TIMEOUT
  );
});
