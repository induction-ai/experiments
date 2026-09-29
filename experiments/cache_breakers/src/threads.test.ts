import { describe, expect, it } from "vitest";
import { apply, initialDraft, toBlocks, type Action, type Draft } from "./threads.js";

const run = (...actions: Action[]): Draft =>
  actions.reduce((d, a) => apply(d, a), initialDraft());
const stems = (d: Draft, updates: boolean) =>
  toBlocks(d, () => 10, { updates }).map((b) => b.key);
const set = (value: string): Action => ({ kind: "set", name: "effort", value });

describe("effort updates", () => {
  it("sit after the user message they apply from, and replay there", () => {
    const d = run({ kind: "next" }, set("high"), { kind: "next" });
    expect(stems(d, true)).toEqual([
      "tools@0", "system@0", "u1@0", "r1@0", "u2@0", "cfg1@0", "r2@0", "u3@0",
    ]);
    // An API that sets effort per request never sees the item.
    expect(stems(d, false)).not.toContain("cfg1@0");
    expect(d.params.effort).toBe("high");
  });

  it("replace a pending update rather than sit next to it", () => {
    const d = run(set("high"), set("max"));
    const updates = d.parts.filter((p) => p.role === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.value).toBe("max");
  });

  it("vanish when changed back before the next message", () => {
    const d = run(set("high"), set("low"));
    expect(d.parts.some((p) => p.role === "update")).toBe(false);
  });

  it("come back after a branch that dropped them", () => {
    const d = run({ kind: "next" }, set("high"), { kind: "branch", turn: 2 });
    const last = d.parts.at(-1)!;
    expect(last.role).toBe("update");
    expect(last.value).toBe("high");
  });
});
