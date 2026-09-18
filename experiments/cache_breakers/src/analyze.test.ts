import { describe, expect, it } from "@experiments/test";
import {
  boundaries,
  breakPoint,
  summarise,
  tier,
  type Obs,
} from "./analyze.js";

const obs = (
  variant: string,
  cached: number,
  extra: Partial<Obs> = {}
): Obs => ({
  provider: "p",
  model: "m",
  variant,
  group: "g",
  section_words: 1500,
  warmed: true,
  base_cached: 6000,
  cached,
  cache_write: 6000 - cached,
  error: "",
  ...extra,
});

const probes = [
  obs("tools_edit_start", 1500),
  obs("system_edit_start", 0),
  obs("early_edit_start", 3000),
  obs("late_edit_start", 4500),
  obs("final_edit", 5990),
];

describe("boundaries", () => {
  it("orders sections by their start probe", () => {
    expect(boundaries(probes).map((b) => b.sections)).toEqual([
      ["system"],
      ["tools"],
      ["early"],
      ["late"],
      ["final"],
    ]);
  });

  it("merges sections whose probes land on the same checkpoint", () => {
    const b = boundaries([
      obs("tools_edit_start", 0),
      obs("system_edit_start", 0),
      obs("early_edit_start", 3066),
      obs("late_edit_start", 3060),
      obs("final_edit", 3054),
    ]);
    expect(b).toEqual([
      { sections: ["tools", "system"], start: 0 },
      { sections: ["early", "late", "final"], start: 3054 },
    ]);
  });

  it("ignores unwarmed and errored rows", () => {
    const b = boundaries([
      obs("tools_edit_start", 1500),
      obs("tools_edit_start", 99, { warmed: false }),
      obs("tools_edit_start", 99, { error: "boom" }),
    ]);
    expect(b).toEqual([{ sections: ["tools"], start: 1500 }]);
  });
});

describe("breakPoint", () => {
  const b = boundaries(probes);
  it("labels a full hit", () => expect(breakPoint(5995, 6000, b)).toBe("full"));
  it("labels a section boundary", () =>
    expect(breakPoint(3005, 6000, b)).toBe("early"));
  it("labels a partial match inside a section", () =>
    expect(breakPoint(3700, 6000, b)).toBe("within:early"));
  it("labels a small tail loss as within the last region", () =>
    expect(breakPoint(5880, 6000, b)).toBe("within:late"));
  it("labels no reuse at the first section", () =>
    expect(breakPoint(0, 6000, b)).toBe("system"));
});

describe("summarise", () => {
  it("reports the modal break point and agreement", () => {
    const rows = [
      ...probes,
      obs("x", 3000),
      obs("x", 3010),
      obs("x", 6000),
      obs("x", 0, { error: "bad param", warmed: true, cached: null }),
    ];
    const x = summarise(rows).find((s) => s.variant === "x")!;
    expect(x.trials).toBe(4);
    expect(x.usable).toBe(3);
    expect(x.errors).toBe(1);
    expect(x.firstError).toBe("bad param");
    expect(x.breaksAt).toBe("early");
    expect(x.agreement).toBeCloseTo(2 / 3);
  });
});

describe("tier", () => {
  const tierOf = (rows: Obs[]) =>
    tier(summarise([...probes, ...rows]).find((s) => s.variant === "x")!);

  it("zero when nothing is reused", () =>
    expect(tierOf([obs("x", 0)])).toBe("zero"));
  it("none when everything is reused", () =>
    expect(tierOf([obs("x", 5998, { cache_write: 0 })])).toBe("none"));
  it("fallback when the rest is re-written", () =>
    expect(tierOf([obs("x", 3000)])).toBe("fallback"));
  it("tail when the loss is billed but nothing is written", () =>
    expect(tierOf([obs("x", 5880, { cache_write: 0 })])).toBe("tail"));
  it("fallback, not tail, when a large loss writes nothing (gpt-5.5)", () =>
    expect(tierOf([obs("x", 2700, { cache_write: 0 })])).toBe("fallback"));
  it("rejected when no trial succeeded", () =>
    expect(tierOf([obs("x", 0, { error: "nope", cached: null })])).toBe(
      "rejected"
    ));
});
