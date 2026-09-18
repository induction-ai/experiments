import { SECTIONS, type Section } from "./fixture.js";

/** The subset of a results row the analysis needs, parsed from CSV. */
export interface Obs {
  provider: string;
  model: string;
  variant: string;
  group: string;
  section_words: number;
  warmed: boolean;
  base_cached: number | null;
  cached: number | null;
  cache_write: number | null;
  error: string;
}

export function toObs(r: Record<string, string>): Obs {
  const num = (s: string | undefined) =>
    s === undefined || s === "" ? null : Number(s);
  return {
    provider: r.provider ?? "",
    model: r.model ?? "",
    variant: r.variant ?? "",
    group: r.group ?? "",
    section_words: Number(r.section_words ?? 0),
    warmed: r.warmed === "true",
    base_cached: num(r.base_cached),
    cached: num(r.cached),
    cache_write: num(r.cache_write),
    error: r.error ?? "",
  };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Probe whose cached count marks where each section starts in the prefix. */
export const START_PROBE: Record<Section, string> = {
  tools: "tools_edit_start",
  system: "system_edit_start",
  early: "early_edit_start",
  late: "late_edit_start",
  final: "final_edit",
};

export interface Boundary {
  /** Sections whose start probes land on this offset (within tolerance). */
  sections: Section[];
  /** Median cached tokens when the first token of these sections changes. */
  start: number;
}

/**
 * Recover the cache checkpoints from the start probes, sorted into the order
 * the provider renders them. Sections whose probes land on the same offset
 * are merged: the cache can't tell them apart, so their relative order is
 * unknowable from caching alone. Sections with no usable probe are omitted.
 */
// Section sizes vary by a few tokens between trials (random filler), so a
// variant's cached count is compared with other trials' probes loosely.
// Sections are ~1500 tokens apart, so 64 cannot confuse two of them.
const ACROSS_TRIALS = 64;
// "Full" compares against the same trial's warm base, so it can be tight.
const WITHIN_TRIAL = 16;

export function boundaries(obs: Obs[], tolerance = ACROSS_TRIALS): Boundary[] {
  const starts: { section: Section; start: number }[] = [];
  for (const section of SECTIONS) {
    const xs = usable(obs)
      .filter((o) => o.variant === START_PROBE[section])
      .map((o) => o.cached!);
    const m = median(xs);
    if (m !== null) starts.push({ section, start: m });
  }
  starts.sort((a, b) => a.start - b.start);
  const out: Boundary[] = [];
  for (const s of starts) {
    const last = out[out.length - 1];
    if (last && s.start - last.start <= tolerance) {
      last.sections.push(s.section);
      // Within a merged checkpoint, list sections in request order.
      last.sections.sort((a, b) => SECTIONS.indexOf(a) - SECTIONS.indexOf(b));
    } else {
      out.push({ sections: [s.section], start: s.start });
    }
  }
  return out;
}

/** Rows where the base was warm and the variant call succeeded. */
export function usable(obs: Obs[]): Obs[] {
  return obs.filter((o) => o.warmed && !o.error && o.cached !== null);
}

export const label = (b: Boundary) => b.sections.join("/");

/**
 * Name the checkpoint a variant broke the cache at: the boundary whose start
 * offset matches the cached count. `full` means nothing was lost. A count
 * between two boundaries means the match stopped part-way through a region,
 * reported as `within:<boundary>`.
 */
export function breakPoint(
  cached: number,
  baseCached: number,
  bounds: Boundary[]
): string {
  if (cached >= baseCached - WITHIN_TRIAL) return "full";
  for (const b of bounds) {
    if (Math.abs(cached - b.start) <= ACROSS_TRIALS) return label(b);
  }
  const inside = [...bounds].reverse().find((b) => b.start < cached);
  return inside ? `within:${label(inside)}` : "start";
}

export interface VariantSummary {
  provider: string;
  model: string;
  variant: string;
  group: string;
  trials: number;
  usable: number;
  errors: number;
  firstError: string;
  medianCached: number | null;
  medianBaseCached: number | null;
  /** Median tokens the warm base had cached that the variant did not reuse. */
  medianLost: number | null;
  /** Median tokens the variant call wrote to cache (null if not reported). */
  medianWrite: number | null;
  /** Median fraction of the warm base's cached tokens kept by the variant. */
  keptFraction: number | null;
  /** Most common break point across usable trials. */
  breaksAt: string;
  /** Fraction of usable trials that agree with `breaksAt`. */
  agreement: number | null;
}

export function summarise(obs: Obs[]): VariantSummary[] {
  const groups = new Map<string, Obs[]>();
  for (const o of obs) {
    const k = `${o.provider}\t${o.model}\t${o.variant}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const byModel = new Map<string, Boundary[]>();
  const boundsFor = (provider: string, model: string) => {
    const k = `${provider}\t${model}`;
    if (!byModel.has(k)) {
      byModel.set(
        k,
        boundaries(
          obs.filter((o) => o.provider === provider && o.model === model)
        )
      );
    }
    return byModel.get(k)!;
  };

  return [...groups.values()].map((rows) => {
    const r0 = rows[0]!;
    const ok = usable(rows);
    const bounds = boundsFor(r0.provider, r0.model);
    const labels = ok.map((o) => breakPoint(o.cached!, o.base_cached!, bounds));
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const errored = rows.filter((o) => o.error);
    return {
      provider: r0.provider,
      model: r0.model,
      variant: r0.variant,
      group: r0.group,
      trials: rows.length,
      usable: ok.length,
      errors: errored.length,
      firstError: errored[0]?.error ?? "",
      medianCached: median(ok.map((o) => o.cached!)),
      medianBaseCached: median(ok.map((o) => o.base_cached!)),
      medianLost: median(ok.map((o) => o.base_cached! - o.cached!)),
      medianWrite: median(
        ok.filter((o) => o.cache_write !== null).map((o) => o.cache_write!)
      ),
      keptFraction: median(ok.map((o) => o.cached! / o.base_cached!)),
      breaksAt: top?.[0] ?? "",
      agreement: top ? top[1] / ok.length : null,
    };
  });
}

/**
 * How a change affects a warm cache, coarsest first:
 * - `zero`: nothing reused.
 * - `fallback`: reuse stops at an earlier checkpoint; the rest is re-written.
 * - `tail`: most is reused, the rest is billed uncached and nothing is
 *   written (the prompt's end is swapped, not invalidated).
 * - `none`: everything reused.
 * - `rejected`: the API refused the request.
 */
export type Tier = "zero" | "fallback" | "tail" | "none" | "rejected";

export const TIERS: Tier[] = ["zero", "fallback", "tail", "none", "rejected"];

export function tier(s: VariantSummary): Tier {
  if (s.usable === 0) return "rejected";
  if (s.breaksAt === "full") return "none";
  if ((s.medianCached ?? 0) <= WITHIN_TRIAL) return "zero";
  // The tail signature is a small loss with nothing written. Both matter:
  // some models (gpt-5.5) report 0 cache writes on every request.
  if (s.medianWrite === 0 && (s.keptFraction ?? 0) >= 0.9) return "tail";
  return "fallback";
}
