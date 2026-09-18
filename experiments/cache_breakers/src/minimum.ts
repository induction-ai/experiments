import { buildFixture, editEnd, mulberry32, words } from "./fixture.js";
import type { Adapter, CallResult, Json } from "./providers/types.js";

export type MinimumProbe = "whole" | "header";

export interface MinimumRow {
  provider: string;
  model: string;
  probe: MinimumProbe;
  words: number;
  seed: number;
  nonce: string;
  /**
   * input_tokens of the request whose size is under test: the whole prompt
   * for `whole`, a header-only request (instructions + final) for `header`.
   */
  size_tokens: number | null;
  /** Calls made while trying to get a hit. */
  calls: number;
  /** Largest cached count seen on a repeat of the probe request. */
  cached: number | null;
  error: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Both probes are shaped as OpenAI Responses bodies for now; other providers
// get their own builders when their adapters land.
function instructionsOnly(
  adapter: Adapter,
  model: string,
  nonce: string,
  seed: number,
  n: number
): Json {
  const f = buildFixture({ seed, nonce, sectionWords: 200 });
  const body = adapter.render(f, model);
  delete body.tools;
  body.instructions = `[${nonce}] ${words(mulberry32(seed), n)}`;
  body.input = [{ role: "user", content: f.final }];
  return body;
}

/**
 * `whole`: send one prompt of `n` words up to `maxCalls` times and record the
 * largest cached count on a repeat. 0 on every repeat means the prompt is
 * below the minimum cacheable size.
 *
 * `header`: warm a request with an `n`-word system prompt (no tools) and a
 * large history, then edit the final message. A cached count equal to the
 * header means the header alone is a reusable checkpoint; 0 means it's below
 * the minimum. A header-only request is sent last, to measure its size
 * without seeding the cache before the edit.
 */
export async function runMinimum(
  adapter: Adapter,
  probe: MinimumProbe,
  opts: {
    model: string;
    words: number;
    seed: number;
    nonce: string;
    maxCalls: number;
    delayMs: number;
    historyWords: number;
  }
): Promise<MinimumRow> {
  const row: MinimumRow = {
    provider: adapter.name,
    model: opts.model,
    probe,
    words: opts.words,
    seed: opts.seed,
    nonce: opts.nonce,
    size_tokens: null,
    calls: 0,
    cached: null,
    error: "",
  };
  const header = instructionsOnly(
    adapter,
    opts.model,
    opts.nonce,
    opts.seed,
    opts.words
  );

  const send = async (body: Json): Promise<CallResult | null> => {
    if (row.calls > 0) await sleep(opts.delayMs);
    row.calls++;
    const r = await adapter.send(body);
    if (r.error) {
      row.error = r.error;
      return null;
    }
    return r;
  };

  if (probe === "whole") {
    let best = 0;
    for (let i = 0; i < opts.maxCalls; i++) {
      const r = await send(header);
      if (!r) return row;
      row.size_tokens = r.usage?.input ?? null;
      if (i > 0) best = Math.max(best, r.usage?.cached ?? 0);
      if (best > 0) break;
    }
    row.cached = best;
    return row;
  }

  // header probe
  const rng = mulberry32(opts.seed + 1);
  const base: Json = {
    ...header,
    input: [
      {
        role: "user",
        content: `[${opts.nonce}] ${words(rng, opts.historyWords)}`,
      },
      { role: "assistant", content: words(rng, opts.historyWords) },
      { role: "user", content: "Reply with the single word ok." },
    ],
  };
  let warmed = false;
  for (let i = 0; i < opts.maxCalls && !warmed; i++) {
    const r = await send(base);
    if (!r) return row;
    warmed = i > 0 && (r.usage?.cached ?? 0) > 0;
  }
  if (!warmed) {
    row.error = "base never reported a cache hit";
    return row;
  }
  const edited = structuredClone(base);
  const input = edited.input as Json[];
  const last = input[input.length - 1]!;
  last.content = editEnd(last.content as string);
  const v = await send(edited);
  if (!v) return row;
  row.cached = v.usage?.cached ?? null;
  const size = await send(header);
  if (!size) return row;
  row.size_tokens = size.usage?.input ?? null;
  return row;
}
