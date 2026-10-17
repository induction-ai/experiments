import { describe, expect, it } from "@experiments/test";
import { parseContent, parseUsage } from "./gemini.js";
import { stripSigs } from "./sig.js";

describe("gemini response parsing", () => {
  it("a missing cachedContentTokenCount means nothing was cached", () => {
    expect(
      parseUsage({
        usageMetadata: { promptTokenCount: 34, candidatesTokenCount: 13 },
      })
    ).toEqual({ prompt: 34, cached: 0, output: 13, thoughts: null });
  });

  it("reads cached and thought tokens when present", () => {
    expect(
      parseUsage({
        usageMetadata: {
          promptTokenCount: 12396,
          cachedContentTokenCount: 10352,
          candidatesTokenCount: 1,
          thoughtsTokenCount: 83,
        },
      })
    ).toEqual({ prompt: 12396, cached: 10352, output: 1, thoughts: 83 });
  });

  it("returns null usage for an error body", () => {
    expect(parseUsage({ error: { code: 400 } })).toBeNull();
  });

  it("takes the first candidate's content verbatim", () => {
    const content = {
      role: "model",
      parts: [{ text: "Hi", thoughtSignature: "abc" }],
    };
    expect(parseContent({ candidates: [{ content }] })).toEqual(content);
  });

  it("stripSigs removes every signature and nothing else", () => {
    expect(
      stripSigs({
        role: "model",
        parts: [
          { functionCall: { name: "f", args: {} }, thoughtSignature: "s1" },
          { text: "t", thoughtSignature: "s2" },
        ],
      })
    ).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "f", args: {} } }, { text: "t" }],
    });
  });
});
