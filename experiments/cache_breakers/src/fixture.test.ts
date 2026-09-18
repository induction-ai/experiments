import { describe, expect, it } from "@experiments/test";
import { buildFixture, editEnd, editStart } from "./fixture.js";

describe("buildFixture", () => {
  const opts = { seed: 7, nonce: "abc123", sectionWords: 400 };

  it("is deterministic for a seed", () => {
    expect(buildFixture(opts)).toEqual(buildFixture(opts));
    expect(buildFixture({ ...opts, seed: 8 }).system).not.toEqual(
      buildFixture(opts).system
    );
  });

  it("tags the start of every section with the nonce", () => {
    const f = buildFixture(opts);
    const tag = "[abc123] ";
    expect(f.tools[0]!.description.startsWith(tag)).toBe(true);
    expect(f.system.startsWith(tag)).toBe(true);
    expect(f.early[0].text.startsWith(tag)).toBe(true);
    expect(f.late[0].text.startsWith(tag)).toBe(true);
  });

  it("sizes sections near the requested word count", () => {
    const f = buildFixture(opts);
    const count = (s: string) => s.split(" ").length;
    expect(count(f.system)).toBeGreaterThan(400);
    expect(count(f.early[0].text) + count(f.early[1].text)).toBeGreaterThan(
      390
    );
    const toolWords = f.tools
      .map((t) => count(t.description) + 12)
      .reduce((a, b) => a + b, 0);
    expect(toolWords).toBeGreaterThan(100);
  });
});

describe("edits", () => {
  it("editStart changes only the first character", () => {
    expect(editStart("[abc] rest")).toBe("Xabc] rest");
  });

  it("editEnd appends a word", () => {
    expect(editEnd("a b")).toBe("a b zebra");
  });
});
