// The edit-position probe: is a cache hit all or nothing per stored entry,
// or does a request that diverges partway reuse everything up to the edit?
//
// Per trial: one user message of `words` filler words + a question is sent
// twice (the second send confirms it is cached). Then, for each fraction f
// in ascending order, a copy with the single word at position f·words
// replaced is sent once. Ascending order means no earlier sibling shares a
// longer prefix with a later one than the base does.
//
// A prefix cache that reuses any matching run of tokens caches about
// f·tokens on the edit at f (rounded to its granularity). A cache that stores
// one entry per request and reuses it only when the new request contains the
// whole entry caches 0 on every edit.
//
// Shape `split` sends the same text as two messages, user and model, cut at
// SPLIT of the way through (the question stays at the end), so that the
// request has a message boundary before the cached span ends. If entries
// are only found through a shared message boundary, edits after the span
// keep it in `split` but lose it in `one`.
import { filler } from "./filler.js";
import {
  generate,
  GENERATION_CONFIG,
  sleep,
  type Request,
  type Usage,
} from "./gemini.js";

const QUESTION = "Reply with the single word OK.";

/** Replace the word at `frac` of the way through (after the nonce header). */
export function editWordAt(text: string, frac: number): string {
  const lines = text.split("\n");
  const body = lines.slice(1).join("\n").split(" ");
  const i = Math.min(
    body.length - 1,
    Math.max(0, Math.floor(frac * body.length))
  );
  body[i] = body[i] === "zephyr" ? "quartz" : "zephyr";
  return [lines[0], body.join(" ")].join("\n");
}

export const EDIT_SHAPES = ["one", "split"] as const;
export type EditShape = (typeof EDIT_SHAPES)[number];
/** Where `split` cuts the text: before the 0.5 edit, well before the span end. */
export const SPLIT = 0.4;

export function editRequest(text: string, shape: EditShape = "one"): Request {
  if (shape === "one") {
    return {
      contents: [{ role: "user", parts: [{ text: `${text}\n\n${QUESTION}` }] }],
      generationConfig: GENERATION_CONFIG,
    };
  }
  const words = text.split(" ");
  const cut = Math.floor(SPLIT * words.length);
  return {
    contents: [
      { role: "user", parts: [{ text: words.slice(0, cut).join(" ") }] },
      { role: "model", parts: [{ text: words.slice(cut).join(" ") }] },
      { role: "user", parts: [{ text: QUESTION }] },
    ],
    generationConfig: GENERATION_CONFIG,
  };
}

export interface EditTrial {
  base: Usage[];
  edits: { frac: number; usage: Usage }[];
  error: string | null;
}

export async function runEdit(opts: {
  model: string;
  words: number;
  fracs: number[];
  shape?: EditShape;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<EditTrial> {
  const text = filler(opts.seed, opts.nonce, opts.words);
  const out: EditTrial = { base: [], edits: [], error: null };
  for (let i = 0; i < 2; i++) {
    const r = await generate(opts.model, editRequest(text, opts.shape));
    if (!r.usage) return { ...out, error: r.error };
    out.base.push(r.usage);
    await sleep(opts.delayMs);
  }
  for (const frac of [...opts.fracs].sort((a, b) => a - b)) {
    const r = await generate(
      opts.model,
      editRequest(editWordAt(text, frac), opts.shape)
    );
    if (!r.usage) return { ...out, error: r.error };
    out.edits.push({ frac, usage: r.usage });
    await sleep(opts.delayMs);
  }
  return out;
}
