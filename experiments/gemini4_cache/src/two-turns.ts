// Two conversations that both open with a 10,000-token message and grow to
// about 13,000 tokens on the second request, billed very differently.
// `openingWords` and `appendWords` change the sizes (e.g. 4,050 + 1,000 for
// a ~4,100-token opening followed by 1,000 more tokens).
//
//   your_text   turn 1 asks for a one-word reply; turn 2 appends 3,000 tokens
//               of your own text (`appendWords` changes the amount).
//   long_reply  turn 1 asks for a ~3,500-token reply; turn 2 appends a short
//               follow-up, so the model's reply is the 3,000 tokens.
//
// Each turn is one plain generateContent call; `generate` POSTs the body
// below unchanged to
//   https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
import { filler } from "./filler.js";
import {
  countTokens,
  generate,
  sleep,
  type Content,
  type Request,
} from "./gemini.js";

export const KINDS = ["your_text", "long_reply"] as const;
export type Kind = (typeof KINDS)[number];

const ASK = {
  your_text: "Reply with the single word OK.",
  long_reply:
    "Write 40 numbered paragraphs of about 80 words each, using the words above.",
};

function request(contents: Content[]): Request {
  return {
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
}

export interface Turn {
  prompt: number; // usageMetadata.promptTokenCount
  cached: number; // usageMetadata.cachedContentTokenCount
  output: number; // usageMetadata.candidatesTokenCount
  counted: number; // countTokens of the same request (detects argon's hidden block)
}

export async function twoTurns(opts: {
  model: string;
  kind: Kind;
  seed: number;
  nonce: string;
  delayMs: number;
  openingWords?: number;
  appendWords?: number;
}): Promise<{ turn1: Turn; turn2: Turn }> {
  // Turn 1: the opening message (10,000 tokens unless `openingWords` says).
  const words = opts.openingWords ?? 10_000;
  const opening = `Reference ${opts.nonce}.\n${filler(opts.seed, "opening", words)}`;
  const turn1 = request([
    { role: "user", parts: [{ text: `${opening}\n\n${ASK[opts.kind]}` }] },
  ]);
  const r1 = await generate(opts.model, turn1);
  if (!r1.usage || !r1.content) throw new Error(`turn 1: ${r1.error}`);

  // Turn 2: the same conversation, plus the model's reply, plus a new message.
  const followUp =
    opts.kind === "your_text"
      ? `${filler(opts.seed + 1, "more", opts.appendWords ?? 3_000)}\n\nReply with the single word OK.`
      : "Thanks. Reply with the single word OK.";
  const turn2 = request([
    ...turn1.contents,
    r1.content, // the reply, sent back exactly as returned
    { role: "user", parts: [{ text: followUp }] },
  ]);
  await sleep(opts.delayMs);
  const r2 = await generate(opts.model, turn2);
  if (!r2.usage) throw new Error(`turn 2: ${r2.error}`);

  const turn = (u: NonNullable<typeof r1.usage>, counted: number): Turn => ({
    prompt: u.prompt,
    cached: u.cached,
    output: u.output,
    counted,
  });
  return {
    turn1: turn(r1.usage, await countTokens(opts.model, turn1)),
    turn2: turn(r2.usage, await countTokens(opts.model, turn2)),
  };
}
