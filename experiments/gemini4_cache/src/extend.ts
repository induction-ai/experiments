// The extension probe: in a thread where every request is sent exactly once
// (the way a real client talks to the API), does each request reuse the
// cache entry the previous one left?
//
// Step 0 is one big user message. Every later step appends the model's real
// reply to the previous step and a short user message, then sends the thread
// once. A pure prefix cache makes step k cache about prompt_{k-1} minus its
// held-back tail.
//
//   text_chain  the reply is text; the next user message is a short follow-up.
//   tool_chain  an agent loop: toolConfig ANY forces a function call (with a
//               thoughtSignature) at every step, answered by a short
//               functionResponse.
//   long_chain  text_chain, but step 0 asks for a ~3000-word story, so the
//               reply that step 1 appends is long: thousands of tokens on
//               argon, but mostly 1100–1800 on 3.1.
//   mid_chain   the same with a ~700-word story: a reply well under the
//               ~2049-token tail on both models.
//   para_chain  step 0 asks for 40 numbered ~80-word paragraphs: a reply of
//               ~3600 tokens on both models.
import { filler } from "./filler.js";
import {
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Json,
  type Request,
} from "./gemini.js";
import { kind } from "./sig.js";

export const CHAINS = [
  "text_chain",
  "tool_chain",
  "long_chain",
  "mid_chain",
  "para_chain",
] as const;
export type Chain = (typeof CHAINS)[number];

const TOOLS: Json[] = [
  {
    functionDeclarations: [
      {
        name: "lookup_record",
        description: "Look up a catalogue record by its id.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Record id" } },
          required: ["id"],
        },
      },
    ],
  },
];

/** Chains whose step 0 asks for a long reply (maxOutputTokens 8192). */
const LONG_ASKS = {
  long_chain:
    "Write a story of about 3000 words that uses as many of the words above as you can.",
  mid_chain:
    "Write a story of about 700 words that uses as many of the words above as you can.",
  para_chain:
    "Write 40 numbered paragraphs of about 80 words each, using the words above.",
} as const;

export interface ExtendStep {
  step: number;
  prompt: number;
  cached: number;
  /** The reply that the next step appends. */
  replyKind: string;
  replySigBytes: number;
  output: number;
  modelVersion: string | null;
}

function request(chain: Chain, contents: Content[]): Request {
  return {
    contents,
    ...(chain === "tool_chain"
      ? { tools: TOOLS, toolConfig: { functionCallingConfig: { mode: "ANY" } } }
      : {}),
    generationConfig:
      chain in LONG_ASKS
        ? { ...GENERATION_CONFIG, maxOutputTokens: 8192 }
        : GENERATION_CONFIG,
  };
}

/** The user message that follows a reply at step `k` (1-based). */
export function followUp(chain: Chain, reply: Content, k: number): Content {
  if (chain !== "tool_chain") {
    return {
      role: "user",
      parts: [{ text: `Follow-up ${k}: reply with the single word OK.` }],
    };
  }
  const call = reply.parts.find((p) => p.functionCall)?.functionCall;
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          name: call?.name ?? "lookup_record",
          ...(call?.id ? { id: call.id } : {}),
          response: {
            record: `Record ${k}: status open. Next, look up record R-${1000 + k}.`,
          },
        },
      },
    ],
  };
}

export async function runExtend(opts: {
  model: string;
  chain: Chain;
  words: number;
  steps: number;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<{ steps: ExtendStep[]; error: string | null }> {
  const ask =
    LONG_ASKS[opts.chain as keyof typeof LONG_ASKS] ??
    (opts.chain === "tool_chain"
      ? 'Call lookup_record with id "R-1000", then keep following each record’s pointer.'
      : "Reply with the single word OK.");
  const contents: Content[] = [
    {
      role: "user",
      parts: [
        { text: `${filler(opts.seed, opts.nonce, opts.words)}\n\n${ask}` },
      ],
    },
  ];
  const steps: ExtendStep[] = [];
  for (let k = 0; k < opts.steps; k++) {
    const r = await generate(opts.model, request(opts.chain, contents));
    if (!r.usage || !r.content)
      return { steps, error: r.error ?? "no content" };
    steps.push({
      step: k,
      prompt: r.usage.prompt,
      cached: r.usage.cached,
      replyKind: kind(r.content),
      replySigBytes: r.content.parts.reduce(
        (n, p) => n + (p.thoughtSignature?.length ?? 0),
        0
      ),
      output: r.usage.output,
      modelVersion: r.modelVersion,
    });
    contents.push(r.content, followUp(opts.chain, r.content, k + 1));
    if (k < opts.steps - 1) await sleep(opts.delayMs);
  }
  return { steps, error: null };
}
