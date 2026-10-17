// Thin client for the Gemini API (v1beta generateContent and countTokens).
// Raw fetch rather than the AI SDK: the probes need byte-exact control over
// `thoughtSignature` parts and the raw `usageMetadata`.
import { getApiKey } from "@experiments/shared";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type Json = Record<string, unknown>;

export interface Part {
  text?: string;
  functionCall?: { name: string; args?: Json; id?: string };
  functionResponse?: { name: string; response: Json; id?: string };
  thoughtSignature?: string;
  thought?: boolean;
}

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface Request {
  systemInstruction?: { parts: Part[] };
  contents: Content[];
  tools?: Json[];
  toolConfig?: Json;
  generationConfig?: Json;
}

export interface Usage {
  prompt: number;
  /** `cachedContentTokenCount`; absent in the response means 0. */
  cached: number;
  output: number;
  /** `thoughtsTokenCount`, when the model reports it. */
  thoughts: number | null;
}

export interface GenerateResult {
  status: number;
  usage: Usage | null;
  /** The first candidate's content, to feed back as the next model turn. */
  content: Content | null;
  /** `modelVersion` from the response: which backend served it. */
  modelVersion: string | null;
  /** The first candidate's finishReason, e.g. STOP, MAX_TOKENS, SAFETY. */
  finishReason: string | null;
  error: string | null;
}

export function parseUsage(body: Json): Usage | null {
  const u = body.usageMetadata as Json | undefined;
  if (!u || typeof u.promptTokenCount !== "number") return null;
  return {
    prompt: u.promptTokenCount,
    cached:
      typeof u.cachedContentTokenCount === "number"
        ? u.cachedContentTokenCount
        : 0,
    output:
      typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : 0,
    thoughts:
      typeof u.thoughtsTokenCount === "number" ? u.thoughtsTokenCount : null,
  };
}

export function parseContent(body: Json): Content | null {
  const c = (body.candidates as Json[] | undefined)?.[0]?.content as
    | Content
    | undefined;
  return c && Array.isArray(c.parts) ? c : null;
}

const RETRY = new Set([429, 500, 502, 503, 504]);

/**
 * Replays never reach the network and recordings mask the key, so a reader
 * can verify every claim offline without one.
 */
function apiKey(): string {
  if (process.env.VITEST && !process.env.RECORD) {
    return process.env.GEMINI_API_KEY || "replay";
  }
  return getApiKey("gemini");
}

async function post(
  url: string,
  body: unknown
): Promise<{ status: number; json: Json | null; text: string }> {
  let last = { status: 0, json: null as Json | null, text: "" };
  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network failures (timeouts, resets) are retried like a 503.
      last = { status: 0, json: null, text: String(e) };
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: Json | null = null;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // keep text for the error message
    }
    last = { status: res.status, json, text };
    if (!RETRY.has(res.status)) return last;
    await sleep(2000 * 2 ** attempt);
  }
  return last;
}

export async function generate(
  model: string,
  req: Request
): Promise<GenerateResult> {
  const { status, json, text } = await post(
    `${BASE}/${model}:generateContent`,
    req
  );
  if (status !== 200 || !json) {
    return {
      status,
      usage: null,
      content: null,
      modelVersion: null,
      finishReason: null,
      error: text.slice(0, 500),
    };
  }
  return {
    status,
    usage: parseUsage(json),
    content: parseContent(json),
    modelVersion:
      typeof json.modelVersion === "string" ? json.modelVersion : null,
    finishReason:
      ((json.candidates as Json[] | undefined)?.[0]?.finishReason as string) ??
      null,
    // A 200 with no candidate content: say why (e.g. promptFeedback.blockReason).
    error: parseContent(json)
      ? null
      : `no content: ${JSON.stringify({ candidates: json.candidates, promptFeedback: json.promptFeedback }).slice(0, 400)}`,
  };
}

/** `countTokens` over the same request generateContent would get. */
export async function countTokens(
  model: string,
  req: Request
): Promise<number> {
  const { generationConfig: _g, ...rest } = req;
  const { status, json, text } = await post(`${BASE}/${model}:countTokens`, {
    generateContentRequest: { model: `models/${model}`, ...rest },
  });
  if (status !== 200 || typeof json?.totalTokens !== "number") {
    throw new Error(`countTokens ${status}: ${text.slice(0, 300)}`);
  }
  return json.totalTokens;
}

export function sleep(ms: number): Promise<void> {
  // Recorded replays don't need the pauses that keep live runs polite.
  if (process.env.VITEST && !process.env.RECORD) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

export const MODELS = ["gemini-4-argon", "gemini-3.1-pro-preview"] as const;

export const GENERATION_CONFIG = {
  maxOutputTokens: 1024,
  thinkingConfig: { thinkingLevel: "low" },
};
