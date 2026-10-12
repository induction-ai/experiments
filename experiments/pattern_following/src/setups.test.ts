import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@experiments/test";
import type { InputItem } from "./responses.js";
import {
  historyBeforeLastSearch,
  isSnakeCase,
  restyleWithAddedSearches,
  restyleWithFailedSearches,
  restyleWithNewSearches,
  searchPairs,
  toSnakeCase,
  withSystemNote,
} from "./setups.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function historyOf(conversation: string): InputItem[] {
  const captured = JSON.parse(
    fs.readFileSync(
      path.join(here, `../data/${conversation}/final_request.json`),
      "utf8"
    )
  ) as { input: InputItem[] };
  return historyBeforeLastSearch(captured.input);
}

const queries = (input: InputItem[]) =>
  input
    .filter((i) => i.type === "function_call" && i.name === "KB_search")
    .map((i) => (JSON.parse(i.arguments as string) as { query: string }).query);

const shape = (input: InputItem[]) =>
  input.map((i) => i.type ?? "message").join(",");

describe("historyBeforeLastSearch", () => {
  it("ends banking_021 on the customer asking for the disputes to be filed", () => {
    const last = historyOf("banking_021").at(-1)!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toMatch(
      /^Yes, please submit rewards disputes/
    );
  });

  it.each([["banking_021", 7]])(
    "keeps the searches %s made before that point",
    (conversation, count) => {
      expect(queries(historyOf(conversation))).toHaveLength(count);
    }
  );
});

describe("toSnakeCase", () => {
  it("turns a search query into lowercase words joined by underscores", () => {
    expect(
      toSnakeCase("Business Bronze Rewards Card — cash back (earn rate)")
    ).toBe("business_bronze_rewards_card_cash_back_earn_rate");
  });

  it("is recognised as snake_case only when every word is joined", () => {
    expect(isSnakeCase("cash_back_rate")).toBe(true);
    expect(isSnakeCase("cash back rate")).toBe(false);
    expect(isSnakeCase("Cash_Back_Rate")).toBe(false);
    expect(isSnakeCase("cashback")).toBe(false);
  });
});

describe("restyleWithAddedSearches", () => {
  const history = historyOf("banking_021");
  const searchResults = (input: InputItem[]) => {
    const ids = new Set(
      input
        .filter((i) => i.type === "function_call" && i.name === "KB_search")
        .map((i) => i.call_id)
    );
    return input
      .filter((i) => i.type === "function_call_output" && ids.has(i.call_id))
      .map((i) => i.output);
  };

  it("replaces every real search query with ... and adds nothing at 0", () => {
    const edited = restyleWithAddedSearches(history, "dots", 0);
    expect(queries(edited)).toEqual(Array(7).fill("..."));
    expect(shape(edited)).toBe(shape(history));
    expect(searchResults(edited)).toEqual(searchResults(history));
  });

  it("adds each ... search after the history, followed by its own result", () => {
    const edited = restyleWithAddedSearches(history, "dots", 9);
    expect(edited.slice(0, history.length).map((i) => i.type)).toEqual(
      history.map((i) => i.type)
    );
    const added = edited.slice(history.length);
    expect(added).toHaveLength(18);
    for (let k = 0; k < 9; k++) {
      const [call, output] = [added[2 * k]!, added[2 * k + 1]!];
      expect(call).toMatchObject({ type: "function_call", name: "KB_search" });
      expect(output.type).toBe("function_call_output");
      expect(output.call_id).toBe(call.call_id);
    }
    expect(new Set(added.map((i) => i.call_id)).size).toBe(9);
    expect(queries(edited)).toEqual(Array(16).fill("..."));
  });

  it("answers the added searches with the real results in turn, starting over after the last", () => {
    const real = searchResults(history);
    const added = searchResults(
      restyleWithAddedSearches(history, "dots", 9)
    ).slice(7);
    expect(added).toEqual([...real, real[0], real[1]]);
  });

  it("repeats each real search in snake_case with its own result", () => {
    const edited = restyleWithAddedSearches(history, "snake", 9);
    const original = queries(history);
    expect(queries(edited)).toEqual(
      [...original, ...original, original[0]!, original[1]!].map(toSnakeCase)
    );
    const real = searchResults(history);
    expect(searchResults(edited).slice(7)).toEqual([...real, real[0], real[1]]);
  });

  it("adds new searches from a pool in snake_case, each with its own result", () => {
    const pool = [
      { query: "Card closure: pending disputes?", result: "doc A" },
      { query: "replacement card status", result: "doc B" },
      { query: "unused", result: "doc C" },
    ];
    const edited = restyleWithNewSearches(history, "snake", 2, pool);
    const added = searchPairs(edited).slice(7);
    expect(added).toEqual([
      { query: "card_closure_pending_disputes", result: "doc A" },
      { query: "replacement_card_status", result: "doc B" },
    ]);
    expect(queries(edited).slice(0, 7)).toEqual(
      queries(history).map(toSnakeCase)
    );
  });

  it("answers every added search with no results but keeps the real results", () => {
    const edited = restyleWithFailedSearches(history, "dots", 9);
    expect(queries(edited)).toEqual(Array(16).fill("..."));
    const results = searchResults(edited);
    expect(results.slice(0, 7)).toEqual(searchResults(history));
    expect(results.slice(7)).toEqual(Array(9).fill("No results found."));
  });

  it("refuses to add more new searches than the pool holds", () => {
    expect(() =>
      restyleWithNewSearches(history, "snake", 2, [{ query: "a b", result: 1 }])
    ).toThrow();
  });
});

describe("withSystemNote", () => {
  const history = historyOf("banking_021");

  it("adds the note on its own line at the end of the system prompt", () => {
    const edited = withSystemNote(
      history,
      "Do NOT use ... as a KB_search query"
    );
    const system = String(edited[0]!.content);
    expect(system.startsWith(String(history[0]!.content))).toBe(true);
    expect(
      system.endsWith("</policy>\n\nDo NOT use ... as a KB_search query")
    ).toBe(true);
  });

  it("leaves every other item untouched", () => {
    const edited = withSystemNote(history, "note");
    expect(edited.slice(1)).toEqual(history.slice(1));
  });
});
