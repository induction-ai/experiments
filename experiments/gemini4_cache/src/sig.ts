// The signature probe: once a conversation is extended past a model
// function-call turn, does that turn's thoughtSignature cap the cached prefix
// at the signature's position? And does countTokens agree with
// generateContent about the extended conversation?
//
// Per trial (variant `sig`), the way an agent loop really runs:
//   call 0  [u1]                     u1 = PRE words of filler + an ask to call
//                                    a tool; toolConfig ANY forces the call.
//                                    Its reply m1 is a functionCall part
//                                    carrying the model's thoughtSignature.
//   A x2    [u1, m1, u2]             u2 = the functionResponse + POST words.
//                                    The second send shows how much of A the
//                                    cache holds while m1 is still recent.
//   C x2    [u1, m1, u2, m2, u3]     m2 = the model's real reply to A, u3 = a
//                                    short follow-up. The first send of C is
//                                    the measurement: A is a strict prefix of
//                                    C, so a byte-prefix cache reuses all of A.
//
// Variant `text` is the control: m1 is a plain text model turn and u2 plain
// text, of the same sizes, so no function call or signature is involved.
import { filler } from "./filler.js";
import {
  countTokens,
  generate,
  GENERATION_CONFIG,
  sleep,
  type Content,
  type Json,
  type Request,
  type Usage,
} from "./gemini.js";

export const SIG_VARIANTS = ["sig", "text"] as const;
export type SigVariant = (typeof SIG_VARIANTS)[number];

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

const AUTO = { functionCallingConfig: { mode: "AUTO" } };
const ANY = { functionCallingConfig: { mode: "ANY" } };

function req(contents: Content[], toolConfig: Json, tools = true): Request {
  return {
    contents,
    ...(tools ? { tools: TOOLS, toolConfig } : {}),
    generationConfig: GENERATION_CONFIG,
  };
}

export interface SigTrial {
  /** Prompt tokens of call 0: everything before m1. */
  prePrompt: number | null;
  /** Bytes of m1's signature (0 for `text`). */
  sigBytes: number;
  a: Usage[];
  c: Usage[];
  ctA: number | null;
  ctC: number | null;
  /** countTokens of A with m1's signature stripped. */
  ctANoSig: number | null;
  /** What the model's reply to A was: "text", "functionCall" or "mixed". */
  m2Kind: string | null;
  m2SigBytes: number;
  /** Distinct modelVersion values seen across the trial's calls. */
  versions: string[];
  /** Cached tokens on call 0 (expected 0: its prefix is new). */
  cached0: number | null;
  /** countTokens failures, `name: message`, joined by "; ". */
  ctError: string | null;
  error: string | null;
}

export function kind(c: Content): string {
  const fc = c.parts.some((p) => p.functionCall);
  const text = c.parts.some((p) => p.text !== undefined && !p.thought);
  return fc && text ? "mixed" : fc ? "functionCall" : "text";
}

/** Copy a content, dropping every thoughtSignature. */
export function stripSigs(c: Content): Content {
  return {
    role: c.role,
    parts: c.parts.map(({ thoughtSignature: _s, ...p }) => p),
  };
}

export async function runSig(opts: {
  model: string;
  variant: SigVariant;
  preWords: number;
  postWords: number;
  seed: number;
  nonce: string;
  delayMs: number;
}): Promise<SigTrial> {
  const out: SigTrial = {
    prePrompt: null,
    sigBytes: 0,
    a: [],
    c: [],
    ctA: null,
    ctC: null,
    ctANoSig: null,
    m2Kind: null,
    m2SigBytes: 0,
    versions: [],
    cached0: null,
    ctError: null,
    error: null,
  };
  const seen = (v: string | null) => {
    if (v && !out.versions.includes(v)) out.versions.push(v);
  };
  const pre = filler(opts.seed, opts.nonce, opts.preWords);
  const post = filler(opts.seed + 1, "results", opts.postWords);
  const u1: Content = {
    role: "user",
    parts: [
      {
        text: `${pre}\n\nCall lookup_record with id "R-1029" before answering anything else.`,
      },
    ],
  };
  const useTools = opts.variant === "sig";

  let m1: Content;
  let u2: Content;
  if (opts.variant === "sig") {
    const r0 = await generate(opts.model, req([u1], ANY));
    if (!r0.usage || !r0.content)
      return { ...out, error: r0.error ?? "no content" };
    seen(r0.modelVersion);
    out.prePrompt = r0.usage.prompt;
    out.cached0 = r0.usage.cached;
    const call = r0.content.parts.find((p) => p.functionCall);
    if (!call?.functionCall)
      return { ...out, error: "no functionCall in call 0" };
    out.sigBytes = r0.content.parts.reduce(
      (n, p) => n + (p.thoughtSignature?.length ?? 0),
      0
    );
    m1 = r0.content;
    u2 = {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: call.functionCall.name,
            ...(call.functionCall.id ? { id: call.functionCall.id } : {}),
            response: { record: post },
          },
        },
      ],
    };
  } else {
    const r0 = await generate(opts.model, req([u1], AUTO, false));
    if (!r0.usage) return { ...out, error: r0.error };
    seen(r0.modelVersion);
    out.prePrompt = r0.usage.prompt;
    out.cached0 = r0.usage.cached;
    m1 = { role: "model", parts: [{ text: "I will look up record R-1029." }] };
    u2 = { role: "user", parts: [{ text: `Record R-1029:\n${post}` }] };
  }
  await sleep(opts.delayMs);

  const A = [u1, m1, u2];
  let m2: Content | null = null;
  for (let i = 0; i < 2; i++) {
    const r = await generate(opts.model, req(A, AUTO, useTools));
    if (!r.usage || !r.content)
      return { ...out, error: r.error ?? "no content" };
    seen(r.modelVersion);
    out.a.push(r.usage);
    m2 = r.content;
    await sleep(opts.delayMs);
  }

  const u3: Content = {
    role: "user",
    parts: [{ text: "Thanks. Now reply with the single word OK." }],
  };
  out.m2Kind = kind(m2!);
  out.m2SigBytes = m2!.parts.reduce(
    (n, p) => n + (p.thoughtSignature?.length ?? 0),
    0
  );
  const C = [...A, m2!, u3];
  for (let i = 0; i < 2; i++) {
    const r = await generate(opts.model, req(C, AUTO, useTools));
    if (!r.usage) return { ...out, error: r.error };
    seen(r.modelVersion);
    out.c.push(r.usage);
    if (i === 0) await sleep(opts.delayMs);
  }

  // countTokens runs last and fails independently: gemini-4-argon rejects a
  // functionCall without its signature, which is itself a result.
  const errors: string[] = [];
  const count = async (name: string, contents: Content[]) => {
    try {
      return await countTokens(opts.model, req(contents, AUTO, useTools));
    } catch (e) {
      errors.push(`${name}: ${String(e).slice(0, 200)}`);
      return null;
    }
  };
  out.ctA = await count("a", A);
  out.ctC = await count("c", C);
  out.ctANoSig = await count("a_nosig", [u1, stripSigs(m1), u2]);
  out.ctError = errors.length ? errors.join("; ") : null;
  return out;
}
