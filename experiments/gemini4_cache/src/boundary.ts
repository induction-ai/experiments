// The boundary probe: when a request's last message is edited, can it still
// reuse the entry of an earlier request that ended at a previous message?
//
// Contents: u1 (PRE words), m1 (a short model text turn), u2 (POST words +
// the question). Variants, each a fresh trial:
//   cold        send A = [u1, m1, u2] twice, then A' (u2 edited at 50%) once.
//   after_u1    send [u1] once first (a request that ended at u1), then as cold.
//   edit_u1     send [u1] once, A twice, then A with u1 edited at 50% once:
//               nothing before the edit is a whole earlier request except the
//               empty prefix, so every model should miss.
//
// If entries are found only by matching an entire earlier request, `cold`
// misses, `after_u1` reuses [u1]'s entry (about its prompt − tail), and
// `edit_u1` misses. If any stored span that is still intact can be reused,
// `cold` reuses A's span up to the edit as well.
import { editWordAt } from "./edit.js";
import { filler } from "./filler.js";
import {
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Request,
  type Usage,
} from "./gemini.js";

export const BOUNDARY_VARIANTS = ["cold", "after_u1", "edit_u1"] as const;
export type BoundaryVariant = (typeof BOUNDARY_VARIANTS)[number];

const QUESTION = "Reply with the single word OK.";

function req(contents: Content[]): Request {
  return { contents, generationConfig: GENERATION_CONFIG };
}

const user = (text: string): Content => ({ role: "user", parts: [{ text }] });

export interface BoundaryTrial {
  /** Prompt and cached of the [u1] request, when sent. */
  u1: Usage | null;
  a: Usage[];
  edited: Usage | null;
  error: string | null;
}

export async function runBoundary(opts: {
  model: string;
  variant: BoundaryVariant;
  preWords: number;
  postWords: number;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<BoundaryTrial> {
  const out: BoundaryTrial = { u1: null, a: [], edited: null, error: null };
  const pre = filler(opts.seed, opts.nonce, opts.preWords);
  const post = filler(opts.seed + 1, "record", opts.postWords);
  const m1: Content = {
    role: "model",
    parts: [{ text: "Noted. Send the record." }],
  };
  const build = (p: string, q: string) => [
    user(p),
    m1,
    user(`${q}\n\n${QUESTION}`),
  ];

  if (opts.variant !== "cold") {
    const r = await generate(opts.model, req([user(pre)]));
    if (!r.usage) return { ...out, error: r.error };
    out.u1 = r.usage;
    await sleep(opts.delayMs);
  }
  for (let i = 0; i < 2; i++) {
    const r = await generate(opts.model, req(build(pre, post)));
    if (!r.usage) return { ...out, error: r.error };
    out.a.push(r.usage);
    await sleep(opts.delayMs);
  }
  const edited =
    opts.variant === "edit_u1"
      ? build(editWordAt(pre, 0.5), post)
      : build(pre, editWordAt(post, 0.5));
  const r = await generate(opts.model, req(edited));
  if (!r.usage) return { ...out, error: r.error };
  out.edited = r.usage;
  return out;
}
