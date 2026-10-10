import { hasStub } from "./replay.js";
import type { ResponsesResponse } from "./responses.js";
import { DOTS_QUERY, isSnakeCase, SEARCH_TOOL } from "./setups.js";

export type ReplyMeasures = {
  tool_calls: number;
  searches: number;
  snake_queries: number;
  dots_queries: number;
  new_snake_queries: number;
  replayed_queries: number;
  /** Calls of any tool with a `...` argument. */
  stubbed_calls: number;
  sent_message: boolean;
  tool_names: string;
  /** Every call as `name(arguments)`. */
  calls: string;
  queries: string;
  /** Readable reasoning summary text, if the API returned any. */
  reasoning_summary: string;
};

/**
 * `historyQueries` are the search queries already in the request, so a query
 * can be told apart as new or replayed.
 */
export function measureReply(
  response: ResponsesResponse,
  historyQueries: ReadonlySet<string> = new Set()
): ReplyMeasures {
  const calls = response.output.filter((o) => o.type === "function_call");
  const queries = calls
    .filter((c) => c.name === SEARCH_TOOL)
    .map((c) => {
      try {
        return (
          (JSON.parse(c.arguments ?? "") as { query?: string }).query ?? ""
        );
      } catch {
        return "";
      }
    });
  return {
    tool_calls: calls.length,
    searches: queries.length,
    snake_queries: queries.filter(isSnakeCase).length,
    dots_queries: queries.filter((q) => q.trim() === DOTS_QUERY).length,
    new_snake_queries: queries.filter(
      (q) => isSnakeCase(q) && !historyQueries.has(q)
    ).length,
    replayed_queries: queries.filter((q) => historyQueries.has(q)).length,
    stubbed_calls: calls.filter((c) => hasStub(c.arguments ?? "")).length,
    sent_message: response.output.some((o) => o.type === "message"),
    tool_names: calls.map((c) => c.name).join(" | "),
    calls: calls.map((c) => `${c.name}(${c.arguments ?? ""})`).join(" | "),
    queries: queries.join(" | "),
    reasoning_summary: response.output
      .filter((o) => o.type === "reasoning")
      .flatMap((o) => (o.summary ?? []).map((part) => part.text ?? ""))
      .join("\n\n"),
  };
}
