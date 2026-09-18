import { describe, expect, it } from "@experiments/test";
import { generateText } from "ai";
import { getApiKey, getClient, getModel } from "./index.js";

describe("getApiKey", () => {
  it("returns a non-empty key for each service", () => {
    expect(getApiKey("openai")).not.toBe("");
    expect(getApiKey("anthropic")).not.toBe("");
    expect(getApiKey("gemini")).not.toBe("");
  });

  it("throws a helpful error when the env var is missing", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => getApiKey("openai")).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("getClient", () => {
  it("returns a factory that produces a LanguageModel", () => {
    const factory = getClient("gemini_generation");
    const model = factory("gemini-2.5-flash");
    expect(typeof model).toBe("object");
  });
});

describe("getModel + generateText", () => {
  it("calls gemini_generation and returns text", async () => {
    const { text } = await generateText({
      model: getModel("gemini_generation", "gemini-2.5-flash"),
      prompt: "Reply with exactly the word pong.",
    });
    expect(text.toLowerCase()).toContain("pong");
  });

  it("calls openai_completions and returns text", async () => {
    const { text } = await generateText({
      model: getModel("openai_completions", "gpt-4o-mini"),
      prompt: "Reply with exactly the word pong.",
    });
    expect(text.toLowerCase()).toContain("pong");
  });

  it("calls anthropic_messages and returns text", async () => {
    const { text } = await generateText({
      model: getModel("anthropic_messages", "claude-haiku-4-5"),
      prompt: "Reply with exactly the word pong.",
    });
    expect(text.toLowerCase()).toContain("pong");
  });
});
