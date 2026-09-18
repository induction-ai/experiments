import type { Provider } from "@experiments/shared";
import type { FillerStyle, Fixture } from "../fixture.js";

export type Json = Record<string, unknown>;

/** Token usage normalised across providers. */
export interface Usage {
  input: number;
  cached: number;
  /** Tokens written to cache, when the provider reports it (else null). */
  cacheWrite: number | null;
  output: number;
  reasoning: number | null;
}

export interface CallResult {
  status: number;
  usage: Usage | null;
  error: string | null;
  /** Provider response body, for scenarios that feed output back as input. */
  body: Json | null;
}

export type VariantGroup =
  | "control"
  | "probe"
  | "tools"
  | "system"
  | "messages"
  | "model"
  | "reasoning"
  | "output"
  | "sampling"
  | "routing"
  | "loop"
  | "sweep";

export interface VariantContext {
  fixture: Fixture;
  altModel: string;
  /** Tool-loop scenario only: the live response that produced the tool call. */
  seed?: Json;
}

/**
 * One change applied to a warm base request. `apply` receives a deep copy of
 * the base body and returns the body to send.
 */
export interface Variant {
  name: string;
  group: VariantGroup;
  description: string;
  apply: (body: Json, ctx: VariantContext) => Json;
  /**
   * Adjust the base request itself before it is warmed, for variants that
   * need a different starting point (e.g. a different reasoning effort).
   */
  rebase?: (base: Json) => Json;
  /**
   * Extra requests to send once after the base is warm and before the
   * variant, e.g. an earlier turn of the same conversation.
   */
  prewarm?: (base: Json, ctx: VariantContext) => Json[];
}

/**
 * A multi-turn scenario whose base request replays a real tool call,
 * including the provider's reasoning items or signatures.
 */
export interface ToolLoop {
  /** Make the live call that produces a tool call; return the next request. */
  buildBase: (
    fixture: Fixture,
    model: string
  ) => Promise<{ base: Json; seed: Json } | { error: string }>;
  variants: Variant[];
}

export interface Adapter {
  /** Label for the CSV `provider` column; unique per adapter (and mode). */
  name: string;
  provider: Provider;
  /** Filler style the model accepts without refusing (default `words`). */
  fillerStyle?: FillerStyle;
  defaultModel: string;
  altModel: string;
  /** Render the base request for one trial's fixture. */
  render: (fixture: Fixture, model: string) => Json;
  send: (body: Json) => Promise<CallResult>;
  variants: Variant[];
  toolLoop?: ToolLoop;
}
