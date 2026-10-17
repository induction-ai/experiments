// One exact case, run the same way on OpenAI and Gemini:
//
//   turn 1  a single user message of exactly 4,100 prompt tokens (`turn1`
//           changes it, e.g. 4,000 to sit just under argon's minimum)
//   turn 2  the same conversation, plus the model's reply and a new user
//           message, together exactly APPEND (1,000 or 2,500) tokens more
//
// Each request is sized to its exact target with the provider's free
// token-counting endpoint (OpenAI `POST /v1/responses/input_tokens`, Gemini
// `countTokens`). Counting generates nothing, so it can't warm a cache. The
// numbers reported are the billed ones from each response's usage:
//
//   OpenAI  usage.input_tokens, usage.input_tokens_details.cached_tokens
//   Gemini  usageMetadata.promptTokenCount, cachedContentTokenCount
import { getApiKey } from "@experiments/shared";
import { mulberry32, words } from "./filler.js";
import { countTokens, generate, sleep, type Content } from "./gemini.js";

export const TURN1 = 4100;
export const APPENDS = [1000, 2500] as const;
export const QUESTION = "Reply with the single word OK.";

export interface Billed {
  prompt: number;
  cached: number;
}

/** A provider: count a conversation, or send it and get the reply back. */
interface Provider {
  count(messages: Message[]): Promise<number>;
  send(messages: Message[]): Promise<Billed & { reply: Message }>;
}

/** Provider-neutral message; `raw` keeps the provider's own reply object. */
export interface Message {
  role: "user" | "assistant";
  text: string;
  raw?: unknown;
}

// ---- OpenAI Responses -------------------------------------------------------

const OPENAI = "https://api.openai.com/v1/responses";

function openaiKey(): string {
  // Replays never reach the network and recordings mask the key.
  if (process.env.VITEST && !process.env.RECORD)
    return process.env.OPENAI_API_KEY || "replay";
  return getApiKey("openai");
}

async function openaiPost(
  url: string,
  body: unknown
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${openaiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok) return json;
    if (attempt >= 4 || ![429, 500, 502, 503].includes(res.status)) {
      throw new Error(
        `OpenAI ${res.status}: ${JSON.stringify(json).slice(0, 300)}`
      );
    }
    await sleep(2000 * 2 ** attempt);
  }
}

export function openai(model: string, cacheKey: string): Provider {
  const input = (messages: Message[]) =>
    messages.map((m) => ({ role: m.role, content: m.text }));
  return {
    async count(messages) {
      const r = await openaiPost(`${OPENAI}/input_tokens`, {
        model,
        input: input(messages),
      });
      return r.input_tokens as number;
    },
    async send(messages) {
      const r = await openaiPost(OPENAI, {
        model,
        input: input(messages),
        reasoning: { effort: "low" },
        max_output_tokens: 256,
        store: false,
        // Routes both turns to the same cache, as a real client would.
        prompt_cache_key: cacheKey,
      });
      const usage = r.usage as {
        input_tokens: number;
        input_tokens_details?: { cached_tokens?: number };
      };
      const text = (
        r.output as { type: string; content?: { text?: string }[] }[]
      )
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .map((c) => c.text ?? "")
        .join("");
      return {
        prompt: usage.input_tokens,
        cached: usage.input_tokens_details?.cached_tokens ?? 0,
        reply: { role: "assistant", text },
      };
    },
  };
}

// ---- Gemini generateContent -------------------------------------------------

export function gemini(model: string): Provider {
  const contents = (messages: Message[]): Content[] =>
    messages.map((m) =>
      m.raw
        ? (m.raw as Content)
        : {
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.text }],
          }
    );
  const request = (messages: Message[]) => ({
    contents: contents(messages),
    generationConfig: {
      maxOutputTokens: 256,
      thinkingConfig: { thinkingLevel: "low" },
    },
  });
  return {
    async count(messages) {
      return countTokens(model, request(messages));
    },
    async send(messages) {
      const r = await generate(model, request(messages));
      if (!r.usage || !r.content) {
        throw new Error(
          `Gemini: ${r.error ?? `no content (finishReason ${r.finishReason})`}`
        );
      }
      // The reply goes back as plain text. A text part's thoughtSignature is
      // optional, and countTokens doesn't count it the way generateContent
      // bills it, so keeping it would make the sizes off by a few tokens.
      const text = r.content.parts.map((p) => p.text ?? "").join("");
      return {
        prompt: r.usage.prompt,
        cached: r.usage.cached,
        reply: {
          role: "assistant",
          text,
          raw: { role: "model", parts: [{ text }] },
        },
      };
    },
  };
}

// ---- The case ---------------------------------------------------------------

/** Seeded filler of `n` words (about one token each), led by a label. */
function filler(seed: number, label: string, n: number): string {
  return `${label}\n${words(mulberry32(seed), Math.max(0, n))}`;
}

/**
 * Find the filler length that makes `build(n)` count exactly `target` tokens.
 * Words are about one token each, so a few rounds of correction converge.
 */
async function fit(
  provider: Provider,
  build: (n: number) => Message[],
  target: number
): Promise<Message[]> {
  let n = target - (await provider.count(build(0)));
  for (let round = 0; round < 8; round++) {
    const got = await provider.count(build(n));
    if (got === target) return build(n);
    n += target - got;
  }
  throw new Error(`could not size the request to exactly ${target} tokens`);
}

export interface ExactResult {
  turn1: Billed;
  turn2: Billed;
  /** Only when `append3` is given. */
  turn3?: Billed;
}

export async function exactCase(opts: {
  provider: Provider;
  turn1?: number;
  append: number;
  /** A third request, exactly this many tokens more than turn 2. */
  append3?: number;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<ExactResult> {
  const { provider } = opts;
  const size1 = opts.turn1 ?? TURN1;
  const user = (text: string): Message => ({
    role: "user",
    text: `${text}\n\n${QUESTION}`,
  });

  // Turn 1: exactly `size1` tokens (4,100 unless `turn1` says otherwise).
  const turn1 = await fit(
    provider,
    (n) => [user(filler(opts.seed, `Reference ${opts.nonce}.`, n))],
    size1
  );
  const r1 = await provider.send(turn1).catch((e: unknown) => {
    throw new Error(`turn 1: ${String(e)}`);
  });

  // Turn 2: turn 1 + the reply + a new message, exactly `append` tokens more.
  const turn2 = await fit(
    provider,
    (n) => [...turn1, r1.reply, user(filler(opts.seed + 1, "More.", n))],
    size1 + opts.append
  );
  await sleep(opts.delayMs);
  const r2 = await provider.send(turn2).catch((e: unknown) => {
    throw new Error(`turn 2: ${String(e)}`);
  });

  const result: ExactResult = {
    turn1: { prompt: r1.prompt, cached: r1.cached },
    turn2: { prompt: r2.prompt, cached: r2.cached },
  };
  if (opts.append3 === undefined) return result;

  // Turn 3: turn 2 + its reply + a new message, exactly `append3` more.
  const turn3 = await fit(
    provider,
    (n) => [...turn2, r2.reply, user(filler(opts.seed + 2, "Again.", n))],
    size1 + opts.append + opts.append3
  );
  await sleep(opts.delayMs);
  const r3 = await provider.send(turn3).catch((e: unknown) => {
    throw new Error(`turn 3: ${String(e)}`);
  });
  return { ...result, turn3: { prompt: r3.prompt, cached: r3.cached } };
}

export interface BranchResult {
  turn1: Billed;
  /** Absent in the control, which never sends turn 2. */
  turn2?: Billed;
  branch: Billed;
}

/**
 * Does turn 1's end breakpoint survive turn 2? Turn 1 (exactly 4,100), then
 * turn 2 (exactly `append` more), then a branch: turn 1 + its reply + a
 * different new message, exactly `branch` tokens more than turn 1. The branch
 * shares turn 1 and its reply with turn 2, so on Gemini 4 it can resume at
 * turn 1's end (4,101) if that breakpoint still exists, or else at turn 2's
 * point 2,049 before its end (3,051 for +1,000), which lies inside turn 1.
 * `sendTurn2: false` is the control: the branch follows turn 1 directly.
 */
export async function branchCase(opts: {
  provider: Provider;
  append: number;
  branch: number;
  sendTurn2: boolean;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<BranchResult> {
  const { provider } = opts;
  const user = (text: string): Message => ({
    role: "user",
    text: `${text}\n\n${QUESTION}`,
  });
  const turn1 = await fit(
    provider,
    (n) => [user(filler(opts.seed, `Reference ${opts.nonce}.`, n))],
    TURN1
  );
  const r1 = await provider.send(turn1).catch((e: unknown) => {
    throw new Error(`turn 1: ${String(e)}`);
  });

  let turn2: Billed | undefined;
  if (opts.sendTurn2) {
    const request = await fit(
      provider,
      (n) => [...turn1, r1.reply, user(filler(opts.seed + 1, "More.", n))],
      TURN1 + opts.append
    );
    await sleep(opts.delayMs);
    const r2 = await provider.send(request).catch((e: unknown) => {
      throw new Error(`turn 2: ${String(e)}`);
    });
    turn2 = { prompt: r2.prompt, cached: r2.cached };
  }

  // The branch: same turn 1 and reply, a different new message.
  const branch = await fit(
    provider,
    (n) => [...turn1, r1.reply, user(filler(opts.seed + 7, "Instead.", n))],
    TURN1 + opts.branch
  );
  await sleep(opts.delayMs);
  const rb = await provider.send(branch).catch((e: unknown) => {
    throw new Error(`branch: ${String(e)}`);
  });
  return {
    turn1: { prompt: r1.prompt, cached: r1.cached },
    turn2,
    branch: { prompt: rb.prompt, cached: rb.cached },
  };
}
