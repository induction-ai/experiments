import { describe, expect, it } from "@experiments/test";
import { measureReply } from "./measure.js";

const search = (query: string) => ({
  type: "function_call",
  name: "KB_search",
  arguments: JSON.stringify({ query }),
});

describe("measureReply", () => {
  it("counts parallel searches and how many are snake_case", () => {
    const m = measureReply({
      output: [
        { type: "reasoning", summary: [] },
        search("cash_back_dispute_filing"),
        search("Chipotle third party processor"),
        { type: "function_call", name: "get_current_time", arguments: "{}" },
      ],
    });
    expect(m).toMatchObject({
      tool_calls: 3,
      searches: 2,
      snake_queries: 1,
      sent_message: false,
      tool_names: "KB_search | KB_search | get_current_time",
      queries: "cash_back_dispute_filing | Chipotle third party processor",
    });
  });

  it("records a reply to the customer with no tool calls", () => {
    const m = measureReply({
      output: [
        { type: "message", content: [{ type: "output_text", text: "{}" }] },
      ],
    });
    expect(m).toMatchObject({ tool_calls: 0, searches: 0, sent_message: true });
  });

  it("counts only queries that are exactly ... as copied", () => {
    const m = measureReply({
      output: [
        search("..."),
        search(" ... "),
        search("... savings"),
        search(""),
      ],
    });
    expect(m).toMatchObject({ searches: 4, dots_queries: 2 });
  });

  it("tells new snake_case queries apart from ones already in the history", () => {
    const m = measureReply(
      {
        output: [
          search("cash_back_dispute_filing"),
          search("ecocard_green_rewards"),
          search("Chipotle refund policy"),
        ],
      },
      new Set(["cash_back_dispute_filing", "Chipotle refund policy"])
    );
    expect(m).toMatchObject({
      snake_queries: 2,
      new_snake_queries: 1,
      replayed_queries: 2,
    });
  });

  it("keeps the reasoning summary text when the API returns one", () => {
    const m = measureReply({
      output: [
        { type: "reasoning", summary: [{ text: "Repeat the search." }] },
        { type: "reasoning", summary: [] },
        search("..."),
      ],
    });
    expect(m.reasoning_summary).toBe("Repeat the search.");
  });

  it("counts calls of any tool that carry a ... argument", () => {
    const m = measureReply({
      output: [
        search("..."),
        {
          type: "function_call",
          name: "lookup",
          arguments: '{"user_id":"..."}',
        },
        {
          type: "function_call",
          name: "lookup",
          arguments: '{"user_id":"u1"}',
        },
      ],
    });
    expect(m.stubbed_calls).toBe(2);
    expect(m.calls).toBe(
      'KB_search({"query":"..."}) | lookup({"user_id":"..."}) | lookup({"user_id":"u1"})'
    );
  });

  it("counts a search with unreadable arguments as not snake_case", () => {
    const m = measureReply({
      output: [{ type: "function_call", name: "KB_search", arguments: "{bad" }],
    });
    expect(m).toMatchObject({ searches: 1, snake_queries: 0, queries: "" });
  });
});
