// Shared setup for the claim tests. Each claim test runs real trials through
// the same harness the scripts use; recordings are committed, so `pnpm test`
// re-checks every claim offline and `RECORD=true pnpm test` re-runs them live.
import crypto from "node:crypto";
import { expect, recordedValue } from "@experiments/test";
import { buildFixture } from "../fixture.js";
import { openaiResponses } from "../providers/openai-responses.js";
import type { Adapter, Json, Variant } from "../providers/types.js";
import { runTrial, type Scenario, type TrialRow } from "../trial.js";

export const adapter = openaiResponses;
export const LIVE = Boolean(process.env.RECORD);
/** Generous: a live tool-loop claim makes 4–6 calls with pauses. */
export const TIMEOUT = 240_000;

export function variant(
  name: string,
  scenario: Scenario = "static",
  on: Adapter = adapter
): Variant {
  const list =
    scenario === "tool_loop" ? (on.toolLoop?.variants ?? []) : on.variants;
  const v = list.find((x) => x.name === name);
  if (!v) throw new Error(`no ${scenario} variant ${name} on ${on.name}`);
  return v;
}

/**
 * Run one trial of a named variant. The nonce is fresh on every recording
 * (so a live run can't hit a cache left by an earlier one) and replayed
 * verbatim otherwise. Trials in one test share `seed`, so their sections have
 * the same content apart from the nonce.
 */
export async function trial(
  name: string,
  opts: {
    scenario?: Scenario;
    sectionWords?: number;
    seed?: number;
    adapter?: Adapter;
    /** Distinguishes repeat trials of one variant within a test. */
    attempt?: string;
  } = {}
): Promise<TrialRow> {
  const scenario = opts.scenario ?? "static";
  const on = opts.adapter ?? adapter;
  const suffix = opts.attempt ? `:${opts.attempt}` : "";
  const nonce = recordedValue(
    `nonce:${on.name}:${scenario}:${name}${suffix}`,
    () => crypto.randomBytes(6).toString("hex")
  );
  const row = await runTrial(
    on,
    variant(name, scenario, on),
    {
      seed: opts.seed ?? 1234,
      nonce,
      model: on.defaultModel,
      sectionWords: opts.sectionWords ?? 1500,
      maxWarm: 4,
      delayMs: LIVE ? 1500 : 0,
    },
    scenario
  );
  // A classifier refusal says nothing about caching; it's a flaky input,
  // not a failed claim. Re-record just this test to get a fresh nonce.
  if (row.error.includes("refusal")) {
    throw new Error(
      `${on.name} ${name}: ${row.error}. Re-record: RECORD=true pnpm test -t "<this test>"`
    );
  }
  return row;
}

/** Send one request body outside a trial (e.g. to measure a size). */
export async function sendOnce(body: Json) {
  const r = await adapter.send(body);
  expect(r.error).toBeNull();
  return r.usage!;
}

/** The trial ran cleanly: fresh cache, warmed, variant accepted. */
export function expectClean(row: TrialRow) {
  if (row.scenario === "tool_loop") {
    // The seed call is the previous request, so the base's first call
    // already reads that request's checkpoint; it must not read all of it.
    expect(row.first_cached!).toBeLessThan(row.base_cached!);
  } else {
    expect(row.first_cached, "first base call must be uncached").toBe(0);
  }
  expect(row.warmed, "base must warm").toBe(true);
  expect(row.error).toBe("");
  expect(row.base_cached!).toBeGreaterThan(1000);
}

export function expectZero(row: TrialRow) {
  expectClean(row);
  expect(row.cached, `${row.variant} should reuse nothing`).toBe(0);
}

export function expectFull(row: TrialRow) {
  expectClean(row);
  expect(row.cached, `${row.variant} should reuse everything`).toBe(
    row.base_cached
  );
}

/** Reuse stopped part-way and the rest was written again. */
export function expectFallback(row: TrialRow) {
  expectClean(row);
  expect(row.cached!).toBeGreaterThan(0);
  expect(row.cached!).toBeLessThan(row.base_cached!);
  expect(row.cache_write!).toBeGreaterThan(0);
}

/** Token counts from separate trials differ by a few (random nonce tokens). */
export const near = (a: number, b: number, tol = 24) =>
  expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(tol);

/**
 * The base request's tools and instructions (same seed and size as `trial`)
 * with one tiny user message and no history, to measure the header's size.
 */
export function headerOnlyBody(seed = 1234, sectionWords = 1500): Json {
  const nonce = recordedValue("nonce:header-only", () =>
    crypto.randomBytes(6).toString("hex")
  );
  const f = buildFixture({ seed, nonce, sectionWords });
  const body = adapter.render(f, adapter.defaultModel);
  return { ...body, input: [{ role: "user", content: f.final }] };
}
