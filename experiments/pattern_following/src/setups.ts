import type { InputItem } from "./responses.js";

export const SEARCH_TOOL = "KB_search";

const SNAKE_QUERY = /^[a-z0-9]+(_[a-z0-9]+)+$/;

export function toSnakeCase(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isSnakeCase(query: string): boolean {
  return SNAKE_QUERY.test(query);
}

const isSearchCall = (item: InputItem) =>
  item.type === "function_call" && item.name === SEARCH_TOOL;

function withQuery(
  item: InputItem,
  rewrite: (query: string) => string
): InputItem {
  const args = JSON.parse(item.arguments as string) as { query: string };
  return {
    ...item,
    arguments: JSON.stringify({ ...args, query: rewrite(args.query) }),
  };
}

export const DOTS_QUERY = "...";

export const QUERY_STYLES = {
  dots: () => DOTS_QUERY,
  snake: toSnakeCase,
} satisfies Record<string, (query: string) => string>;

export type QueryStyle = keyof typeof QUERY_STYLES;

export type SearchPair = { query: string; result: unknown };

/** The history's real searches, each with its own result. */
export function searchPairs(history: InputItem[]): SearchPair[] {
  const results = new Map(
    history
      .filter((item) => item.type === "function_call_output")
      .map((item) => [item.call_id, item.output])
  );
  return history.filter(isSearchCall).map((item) => ({
    query: (JSON.parse(item.arguments as string) as { query: string }).query,
    result: results.get(item.call_id),
  }));
}

/**
 * Rewrites every search query in `style`, then appends one search per pair,
 * each with the pair's query in `style` and the pair's result.
 */
function restyleAndAppend(
  history: InputItem[],
  style: QueryStyle,
  pairs: SearchPair[]
): InputItem[] {
  const restyle = QUERY_STYLES[style];
  const addedSearches = pairs.flatMap(({ query, result }, k) => {
    const call_id = `call_added_${k}`;
    return [
      {
        type: "function_call",
        call_id,
        name: SEARCH_TOOL,
        arguments: JSON.stringify({ query: restyle(query) }),
      },
      { type: "function_call_output", call_id, output: result },
    ];
  });
  return [
    ...history.map((item) =>
      isSearchCall(item) ? withQuery(item, restyle) : item
    ),
    ...addedSearches,
  ];
}

/**
 * Rewrites every search query in `style`, then appends `added` more searches
 * that repeat the history's real searches in turn, each repeat has the real query in `style` and the
 * real search's result.
 */
export function restyleWithAddedSearches(
  history: InputItem[],
  style: QueryStyle,
  added: number
): InputItem[] {
  const real = searchPairs(history);
  return restyleAndAppend(
    history,
    style,
    Array.from({ length: added }, (_, k) => real[k % real.length]!)
  );
}

export const NO_RESULTS = "No results found.";

/**
 * Like `restyleWithAddedSearches`, but every added search comes back with
 * NO_RESULTS instead of the real search's result.
 */
export function restyleWithFailedSearches(
  history: InputItem[],
  style: QueryStyle,
  added: number
): InputItem[] {
  const real = searchPairs(history);
  return restyleAndAppend(
    history,
    style,
    Array.from({ length: added }, (_, k) => ({
      query: real[k % real.length]!.query,
      result: NO_RESULTS,
    }))
  );
}

/**
 * Rewrites every search query in `style`, then appends the first `added`
 * searches from `pool`, so no added query repeats an earlier one.
 */
export function restyleWithNewSearches(
  history: InputItem[],
  style: QueryStyle,
  added: number,
  pool: SearchPair[]
): InputItem[] {
  if (added > pool.length) {
    throw new Error(`pool has ${pool.length} searches, ${added} requested`);
  }
  return restyleAndAppend(history, style, pool.slice(0, added));
}

/** Appends `note` on its own line to the end of the system prompt. */
export function withSystemNote(input: InputItem[], note: string): InputItem[] {
  return input.map((item) =>
    item.role === "system" && typeof item.content === "string"
      ? { ...item, content: `${item.content}\n\n${note}` }
      : item
  );
}

/**
 * The history up to the point where the agent, in the original run, sent its
 * last batch of searches: three parallel KB_search calls.
 */
export function historyBeforeLastSearch(input: InputItem[]): InputItem[] {
  const lastSearch = input.findLastIndex(isSearchCall);
  let start = lastSearch;
  while (input[start - 1]?.type === "function_call") start--;
  while (input[start - 1]?.type === "reasoning") start--;
  return input.slice(0, start);
}
