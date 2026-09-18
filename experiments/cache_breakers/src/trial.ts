import { buildFixture } from "./fixture.js";
import type {
  Adapter,
  CallResult,
  Json,
  Variant,
  VariantContext,
} from "./providers/types.js";

export type Scenario = "static" | "tool_loop";

export interface TrialOptions {
  seed: number;
  nonce: string;
  model: string;
  sectionWords: number;
  /** Base requests to send before giving up on warming the cache. */
  maxWarm: number;
  /** Pause between calls, so a cache write is readable before the next call. */
  delayMs: number;
}

export interface TrialRow {
  scenario: Scenario;
  provider: string;
  model: string;
  variant: string;
  group: string;
  seed: number;
  nonce: string;
  section_words: number;
  /** Pre-warm requests sent between warming and the variant. */
  prewarm_calls: number;
  /** Cached tokens on the very first base call; should be 0 (fresh nonce). */
  first_cached: number | null;
  warm_attempts: number;
  /** True when a base call reported cached tokens before the variant was sent. */
  warmed: boolean;
  base_input: number | null;
  base_cached: number | null;
  status: number;
  error: string;
  input: number | null;
  cached: number | null;
  cache_write: number | null;
  output: number | null;
  reasoning: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One trial: build a fresh fixture and base request (for the tool loop, via a
 * live call that produces a tool call), send the base until the provider
 * reports a cache hit on it, send any pre-warm requests, then send the
 * variant once and record its usage.
 */
export async function runTrial(
  adapter: Adapter,
  variant: Variant,
  opts: TrialOptions,
  scenario: Scenario = "static"
): Promise<TrialRow> {
  const fixture = buildFixture({
    seed: opts.seed,
    nonce: opts.nonce,
    sectionWords: opts.sectionWords,
    style: adapter.fillerStyle,
  });
  const ctx: VariantContext = { fixture, altModel: adapter.altModel };

  const row: TrialRow = {
    scenario,
    provider: adapter.name,
    model: opts.model,
    variant: variant.name,
    group: variant.group,
    seed: opts.seed,
    nonce: opts.nonce,
    section_words: opts.sectionWords,
    prewarm_calls: 0,
    first_cached: null,
    warm_attempts: 0,
    warmed: false,
    base_input: null,
    base_cached: null,
    status: 0,
    error: "",
    input: null,
    cached: null,
    cache_write: null,
    output: null,
    reasoning: null,
  };

  let base: Json;
  if (scenario === "tool_loop") {
    if (!adapter.toolLoop) throw new Error(`${adapter.provider}: no tool loop`);
    const built = await adapter.toolLoop.buildBase(fixture, opts.model);
    if ("error" in built) {
      row.error = `tool-loop seed: ${built.error}`;
      return row;
    }
    base = built.base;
    ctx.seed = built.seed;
    await sleep(opts.delayMs);
  } else {
    base = adapter.render(fixture, opts.model);
  }
  if (variant.rebase) base = variant.rebase(structuredClone(base));

  let first: CallResult | null = null;
  let last: CallResult | null = null;
  let attempts = 0;
  while (attempts < opts.maxWarm) {
    if (attempts > 0) await sleep(opts.delayMs);
    last = await adapter.send(base);
    attempts++;
    first ??= last;
    if (last.error) break;
    if (attempts > 1 && (last.usage?.cached ?? 0) > 0) break;
  }

  row.first_cached = first?.usage?.cached ?? null;
  row.warm_attempts = attempts;
  row.warmed = attempts > 1 && (last?.usage?.cached ?? 0) > 0;
  row.base_input = last?.usage?.input ?? null;
  row.base_cached = last?.usage?.cached ?? null;
  if (!row.warmed) {
    row.error = last?.error ?? "base never reported a cache hit";
    return row;
  }

  for (const extra of variant.prewarm?.(structuredClone(base), ctx) ?? []) {
    await sleep(opts.delayMs);
    const r = await adapter.send(extra);
    row.prewarm_calls++;
    if (r.error) {
      row.error = `prewarm: ${r.error}`;
      return row;
    }
  }

  await sleep(opts.delayMs);
  const body = variant.apply(structuredClone(base), ctx);
  const res = await adapter.send(body);
  row.status = res.status;
  row.error = res.error ?? "";
  row.input = res.usage?.input ?? null;
  row.cached = res.usage?.cached ?? null;
  row.cache_write = res.usage?.cacheWrite ?? null;
  row.output = res.usage?.output ?? null;
  row.reasoning = res.usage?.reasoning ?? null;
  return row;
}
