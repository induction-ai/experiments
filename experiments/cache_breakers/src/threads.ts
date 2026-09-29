// A conversation built one action at a time: the reader's thread in the blog
// post, and the random threads scripts/run-sequences.ts sends live. Every
// request starts with the tools and system prompt and ends with a user
// message; replies are fixed text the app sends back, as in the thread
// scenario.
//
// A reasoning effort change is recorded two ways, since APIs differ: as the
// request-level setting (params.effort), and as an `update` part after the
// user message it applies from, the configuration_update item GPT-6 takes
// instead. Each API's blocks keep one or the other (toBlocks' `updates`;
// the engine holds the request-level effort still on APIs that take updates).
//
// Self-contained on purpose: the blog export copies this file verbatim.
import type { Block, Params } from "./engine.js";

export type Role = "tools" | "system" | "user" | "reply" | "update";

export interface Part {
  stem: string;
  role: Role;
  /** The turn a message belongs to (0 for tools and system). */
  turn: number;
  /** Times edited. */
  version: number;
  /** An edit changed its start (so no version shares a prefix with it). */
  startEdited: boolean;
  label: string;
  /** An update's reasoning effort. */
  value?: string;
}

export interface Draft {
  parts: Part[];
  params: Params;
  /** Counter for fresh stems. */
  serial: number;
}

export type Action =
  | { kind: "next" }
  | { kind: "resend" }
  | { kind: "edit"; stem: string; at: "start" | "end" }
  | { kind: "branch"; turn: number }
  | { kind: "cut"; turn: number }
  | { kind: "set"; name: string; value: string };

export const MAX_TURNS = 6;

/** The effort a conversation starts at (the request-level setting). */
export const BASE_EFFORT = "low";

const part = (stem: string, role: Role, turn: number, label: string): Part => ({
  stem,
  role,
  turn,
  version: 0,
  startEdited: false,
  label,
});

const user = (turn: number, serial: number): Part =>
  part(serial ? `u${turn}.${serial}` : `u${turn}`, "user", turn, `user ${turn}`);
const reply = (turn: number, serial: number): Part =>
  part(serial ? `r${turn}.${serial}` : `r${turn}`, "reply", turn, `reply ${turn}`);
const update = (turn: number, serial: number, value: string): Part => ({
  ...part(`cfg${serial}`, "update", turn, "effort update"),
  value,
});

export function initialDraft(params: Params = {}): Draft {
  return {
    parts: [
      part("tools", "tools", 0, "tools"),
      part("system", "system", 0, "system prompt"),
      user(1, 0),
    ],
    params,
    serial: 0,
  };
}

export const turns = (d: Draft) => d.parts.filter((p) => p.role === "user").length;

/** Whether an action applies to this draft. */
export function allowed(d: Draft, a: Action): boolean {
  const n = turns(d);
  switch (a.kind) {
    case "next":
      return n < MAX_TURNS;
    case "resend":
    case "set":
      return true;
    case "edit":
      return d.parts.some((p) => p.stem === a.stem && p.role !== "update");
    case "branch":
      return a.turn >= 1 && a.turn <= n;
    case "cut":
      return a.turn >= 1 && a.turn < n;
  }
}

/** The effort the update parts leave in force. */
function effortInForce(parts: Part[]): string {
  return parts.filter((p) => p.role === "update").at(-1)?.value ?? BASE_EFFORT;
}

/**
 * After a branch or cut drops updates, add one after the new question if
 * the effort in force no longer matches the setting.
 */
function keepEffort(d: Draft, parts: Part[], serial: number): Part[] {
  const wanted = d.params.effort ?? BASE_EFFORT;
  if (effortInForce(parts) === wanted) return parts;
  const n = parts.filter((p) => p.role === "user").length;
  return [...parts, update(n, serial, wanted)];
}

/** The next request's draft. */
export function apply(d: Draft, a: Action): Draft {
  const n = turns(d);
  const serial = d.serial + 1;
  switch (a.kind) {
    case "next": {
      const lastUser = [...d.parts].reverse().find((p) => p.role === "user")!;
      return {
        ...d,
        parts: [...d.parts, reply(n, lineage(lastUser)), user(n + 1, 0)],
      };
    }
    case "resend":
      return d;
    case "edit":
      return {
        ...d,
        parts: d.parts.map((p) =>
          p.stem === a.stem
            ? {
                ...p,
                version: p.version + 1,
                startEdited: p.startEdited || a.at === "start",
              }
            : p
        ),
      };
    case "branch": {
      // Keep everything before user message `turn`; ask something else.
      const keep = d.parts.filter(
        (p) => p.role === "tools" || p.role === "system" || p.turn < a.turn
      );
      const parts = keepEffort(d, [...keep, user(a.turn, serial)], serial);
      return { ...d, serial, parts };
    }
    case "cut": {
      // Keep through reply `turn`; drop the rest and ask something new. An
      // update after user `turn` belongs to that turn, so it stays.
      const keep = d.parts.filter(
        (p) => p.role === "tools" || p.role === "system" || p.turn <= a.turn
      );
      const parts = keepEffort(d, [...keep, user(a.turn + 1, serial)], serial);
      return { ...d, serial, parts };
    }
    case "set": {
      const params = { ...d.params, [a.name]: a.value };
      if (a.name !== "effort") return { ...d, params };
      // Two updates can't sit next to each other: a second change before
      // the next user message replaces the pending one.
      const last = d.parts[d.parts.length - 1]!;
      const pending = last.role === "update";
      const before = pending ? d.parts.slice(0, -1) : d.parts;
      const parts =
        effortInForce(before) === a.value
          ? before
          : [
              ...before,
              pending
                ? { ...last, version: last.version + 1, value: a.value }
                : update(n, serial, a.value),
            ];
      return { ...d, serial, params, parts };
    }
  }
}

/**
 * Replies to a branched question are new text too: key the reply by the
 * user message it answers.
 */
function lineage(p: Part): number {
  const m = /\.(\d+)$/.exec(p.stem);
  return m ? Number(m[1]) : 0;
}

/** Identity of a part's current content. */
export const contentKey = (p: Part) => `${p.stem}@${p.version}`;

/**
 * The draft as blocks, sized by `size`. An end edit keeps the part's
 * leading tokens (`original`: the unedited size, default the current one).
 * `updates`: whether this API sends effort changes as update items.
 */
export function toBlocks(
  d: Draft,
  size: (p: Part) => number,
  opts: { original?: (p: Part) => number; updates?: boolean } = {}
): Block[] {
  const original = opts.original ?? size;
  return d.parts
    .filter((p) => p.role !== "update" || opts.updates)
    .map((p) => ({
      key: contentKey(p),
      stem: p.stem,
      kept: p.startEdited ? 0 : original(p),
      tokens: size(p),
      label: p.label,
    }));
}
