// Each API's cache rules for src/engine.ts, read from the static results:
// where its cache points sit (from the thread and probe findings, fixed
// per API below) and what each setting change did to a warm cache.
import {
  median,
  summarise,
  tier,
  type Obs,
  type VariantSummary,
} from "./analyze.js";
import type { Effect, ParamRule, Rules } from "./engine.js";
import { ANTHROPIC_EFFORTS } from "./providers/anthropic-messages.js";
import { ADAPTERS } from "./providers/index.js";
import { EFFORTS } from "./providers/openai-responses.js";

export interface Setting {
  name: string;
  initial: string;
  values: string[];
}

/** The settings a reader can change, with their provider-neutral values. */
export const SETTINGS: Setting[] = [
  {
    name: "effort",
    initial: "low",
    values: ["none", "low", "medium", "high", "xhigh", "max"],
  },
  { name: "model", initial: "default", values: ["default", "sibling"] },
  { name: "summary", initial: "off", values: ["off", "on"] },
  { name: "tool_choice", initial: "auto", values: ["auto", "required"] },
  { name: "format", initial: "text", values: ["text", "json"] },
  { name: "max_output", initial: "256", values: ["256", "512"] },
  { name: "tier", initial: "default", values: ["default", "other"] },
];

/** The static variant that measured each non-initial value, per provider. */
export const SETTING_VARIANTS: Record<
  "openai" | "anthropic",
  Record<string, Record<string, string>>
> = {
  openai: {
    model: { sibling: "model_switch" },
    summary: { on: "reasoning_summary" },
    tool_choice: { required: "tool_choice_required" },
    format: { json: "json_schema_format" },
    max_output: { "512": "max_output_tokens" },
    tier: { other: "service_tier_priority" },
  },
  anthropic: {
    model: { sibling: "model_switch" },
    summary: { on: "thinking_display_summarized" },
    tool_choice: { required: "tool_choice_any" },
    format: { json: "json_schema_format" },
    max_output: { "512": "max_tokens" },
    tier: { other: "service_tier_standard_only" },
  },
};

/** Where each API leaves cache points (see src/engine.ts). */
const POINTS: Record<string, Omit<Rules, "params">> = {
  openai_responses: { points: "header", headerStem: "system" },
  "openai_responses_gpt-6-luna": { points: "header", headerStem: "system" },
  // Every nonzero read measured is 1536 + 1024k (src/claims/gpt-5.5.test.ts).
  "openai_responses_gpt-5.5": {
    points: "blocks",
    block: { first: 1536, step: 1024 },
  },
  anthropic_auto: { points: "marks", marks: { stems: [], last: true } },
  // The thread scenario's placement: tools, system and the last message.
  anthropic_breakpoints: {
    points: "marks",
    marks: { stems: ["tools", "system"], last: true },
  },
};

export const RULE_COLUMNS = Object.keys(POINTS);

// On OpenAI, low→medium and low→none were run under these names.
const OPENAI_ALIASES: Record<string, string> = {
  effort_low_to_medium: "effort_medium",
  effort_low_to_none: "effort_none",
};

/**
 * A measured change as an engine effect. A partial read is a cut when it
 * lands on the end of the tools or the system prompt, measured on the same
 * API by the probes that edit the start of the system prompt (tools end)
 * and of the first message (system prompt end).
 */
function toEffect(
  s: VariantSummary | undefined,
  landmarks: { stem: string; at: number }[]
): Effect {
  if (!s) return { kind: "unknown" };
  const t = tier(s);
  if (t === "none") return { kind: "keep" };
  if (t === "zero") return { kind: "drop" };
  if (t === "fallback" && s.medianCached !== null) {
    const base = s.medianBaseCached ?? 1;
    const hit = landmarks.find(
      (l) => Math.abs(l.at - s.medianCached!) / base < 0.02
    );
    if (hit) return { kind: "cut", after: hit.stem };
  }
  return { kind: "unknown" };
}

export function buildRules(staticObs: Obs[], size = 1500): Record<string, Rules> {
  const main = staticObs.filter((o) => o.section_words === size);
  const out: Record<string, Rules> = {};
  for (const column of RULE_COLUMNS) {
    const obs = main.filter((o) => o.provider === column);
    const sums = summarise(obs);
    const byName = new Map(sums.map((s) => [s.variant, s]));
    const cachedOf = (v: string) =>
      median(obs.filter((o) => o.variant === v && o.cached !== null).map((o) => o.cached!)) ?? -1;
    const landmarks = [
      { stem: "tools", at: cachedOf("system_edit_start") },
      { stem: "system", at: cachedOf("early_edit_start") },
    ].filter((l) => l.at > 0);
    const provider = column.startsWith("openai") ? "openai" : "anthropic";
    const efforts = provider === "openai" ? EFFORTS : ANTHROPIC_EFFORTS;

    const params: Record<string, ParamRule> = {};
    const effortChanges: ParamRule["changes"] = {};
    for (const from of efforts) {
      for (const to of efforts) {
        if (from === to) continue;
        const name = `effort_${from}_to_${to}`;
        const s = byName.get(name) ?? byName.get(OPENAI_ALIASES[name] ?? "");
        effortChanges[`${from}>${to}`] = toEffect(s, landmarks);
      }
    }
    // A level the API rejects (max on gpt-5.5) isn't one of its values.
    const accepted = efforts.filter((e) =>
      efforts.some((o) => {
        const s = byName.get(`effort_${e}_to_${o}`) ?? byName.get(`effort_${o}_to_${e}`);
        return s !== undefined && tier(s) !== "rejected";
      })
    );
    params.effort = { initial: "low", values: accepted, changes: effortChanges };

    for (const setting of SETTINGS) {
      if (setting.name === "effort") continue;
      const variants = SETTING_VARIANTS[provider][setting.name] ?? {};
      const changes: ParamRule["changes"] = {};
      const values = [setting.initial];
      let tail: ParamRule["tail"];
      for (const [value, variant] of Object.entries(variants)) {
        const s = byName.get(variant);
        if (!s || tier(s) === "rejected") continue;
        values.push(value);
        // A small loss at the end (OpenAI tool_choice) comes from the new
        // value itself, not the change: live threads lose it on every read,
        // header included, while the value is set.
        if (tier(s) === "tail") {
          tail = {
            value,
            tokens: Math.round((s.medianBaseCached ?? 0) - (s.medianCached ?? 0)),
          };
          changes[`${setting.initial}>${value}`] = { kind: "keep" };
        } else {
          changes[`${setting.initial}>${value}`] = toEffect(s, landmarks);
        }
      }
      if (values.length > 1) {
        params[setting.name] = {
          initial: setting.initial,
          values,
          changes,
          ...(tail ? { tail } : {}),
        };
      }
    }
    out[column] = {
      ...POINTS[column]!,
      params,
      ...(ADAPTERS[column]?.effortUpdates ? { effortUpdates: true } : {}),
    };
  }
  return out;
}
