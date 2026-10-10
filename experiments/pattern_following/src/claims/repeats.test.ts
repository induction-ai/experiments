// Claims from blog.md findings 1 to 4: banking_021, gpt-6.1-sol at xhigh,
// cut before the agent's last batch of searches, with N searches added.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@experiments/test";
import {
  DOTS_QUERY,
  restyleWithAddedSearches,
  restyleWithFailedSearches,
  restyleWithNewSearches,
  searchPairs,
  toSnakeCase,
  withSystemNote,
  type SearchPair,
} from "../setups.js";
import { history, sample, TIMEOUT } from "./helpers.js";

const copiesDots = (r: { dots_queries: number }) => r.dots_queries > 0;

describe("repeated calls get repeated, without reasoning", () => {
  it(
    "with 55 `...` searches that return real results, the agent copies without reasoning",
    async () => {
      const replies = await sample(
        restyleWithAddedSearches(history, "dots", 48),
        3
      );
      const copies = replies.filter(copiesDots);
      expect(copies.length).toBeGreaterThanOrEqual(2);
      for (const c of copies) expect(c.reasoning_tokens).toBe(0);
    },
    TIMEOUT
  );

  it(
    "with 11 `...` searches in the history, the agent writes its own queries",
    async () => {
      const replies = await sample(
        restyleWithFailedSearches(history, "dots", 4),
        3
      );
      expect(replies.filter(copiesDots)).toHaveLength(0);
      for (const r of replies) expect(r.reasoning_tokens).toBeGreaterThan(0);
    },
    TIMEOUT
  );
});

describe("failure doesn't stop it", () => {
  it(
    "with 71 failed `...` searches in the history, the agent searches for `...` again without reasoning",
    async () => {
      const input = restyleWithFailedSearches(history, "dots", 64);
      expect(input.at(-1)?.output).toBe("No results found.");
      const replies = await sample(input, 5);
      const copies = replies.filter(copiesDots);
      expect(copies.length).toBeGreaterThanOrEqual(3);
      for (const c of copies) {
        expect(c.queries).toBe(DOTS_QUERY);
        expect(c.reasoning_tokens).toBe(0);
      }
    },
    TIMEOUT
  );
});

describe("an explicit rule doesn't stop it either", () => {
  it(
    "with a system-prompt rule against `...` and 55 `...` searches in the history, the agent still sends `...`",
    async () => {
      const input = withSystemNote(
        restyleWithAddedSearches(history, "dots", 48),
        "Do NOT use ... as a KB_search query"
      );
      const replies = await sample(input, 3);
      const copies = replies.filter(copiesDots);
      expect(copies.length).toBeGreaterThanOrEqual(2);
      for (const c of copies) expect(c.reasoning_tokens).toBe(0);
    },
    TIMEOUT
  );
});

describe("it replays the loop, not the style", () => {
  it(
    "with 55 real searches repeated in snake_case, the agent sends the next search in the cycle",
    async () => {
      const added = 48;
      const real = searchPairs(history);
      const next = toSnakeCase(real[added % real.length]!.query);
      const replies = await sample(
        restyleWithAddedSearches(history, "snake", added),
        3
      );
      const copies = replies.filter((r) => r.snake_queries > 0);
      expect(copies.length).toBeGreaterThanOrEqual(2);
      for (const c of copies) {
        expect(c.queries).toBe(next);
        expect(c.reasoning_tokens).toBe(0);
      }
    },
    TIMEOUT
  );

  it(
    "without repetition, a new snake_case query only comes without reasoning",
    async () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const pool = JSON.parse(
        fs.readFileSync(
          path.join(here, "../../data/kb_search_pool.json"),
          "utf8"
        )
      ) as SearchPair[];
      const replies = await sample(
        restyleWithNewSearches(history, "snake", 48, pool),
        3
      );
      for (const r of replies) {
        expect(r.replayed_queries).toBe(0);
        if (r.new_snake_queries > 0) expect(r.reasoning_tokens).toBe(0);
        if (r.reasoning_tokens > 0) expect(r.snake_queries).toBe(0);
      }
    },
    TIMEOUT
  );
});
