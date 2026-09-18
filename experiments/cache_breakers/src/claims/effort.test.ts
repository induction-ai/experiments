// Claims from blog.md § 3: every reasoning-effort change resets the cache,
// each level keeps its own cache, and medium is the default.
// OpenAI Responses, gpt-5.6-sol.
import { describe, expect, it } from "@experiments/test";
import { EFFORTS } from "../providers/openai-responses.js";
import { expectFull, expectZero, TIMEOUT, trial } from "./helpers.js";

// low→medium and low→none predate the sweep and keep their original names.
const pairName = (from: string, to: string) =>
  from === "low" && to === "medium"
    ? "effort_medium"
    : from === "low" && to === "none"
      ? "effort_none"
      : `effort_${from}_to_${to}`;

const pairs = EFFORTS.flatMap((from) =>
  EFFORTS.filter((to) => to !== from).map((to) => [from, to])
);

describe("reasoning effort", () => {
  it("covers all 30 ordered pairs of the six accepted levels", () => {
    expect(EFFORTS).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(pairs).toHaveLength(30);
  });

  it.each(pairs)(
    "%s → %s reuses nothing, with input_tokens unchanged",
    async (from, to) => {
      const row = await trial(pairName(from, to));
      expectZero(row);
      expect(row.input).toBe(row.base_input);
    },
    TIMEOUT
  );

  it(
    "returning to an earlier level still hits its cache (low → medium → low)",
    async () => {
      expectFull(await trial("effort_switch_back"));
    },
    TIMEOUT
  );

  it(
    "omitting reasoning is the same as medium: full reuse after medium",
    async () => {
      expectFull(await trial("effort_medium_omitted"));
    },
    TIMEOUT
  );

  it.each(["none", "low", "high", "xhigh", "max"])(
    "omitting reasoning after warming at %s reuses nothing",
    async (level) => {
      expectZero(await trial(`effort_${level}_omitted`));
    },
    TIMEOUT
  );
});
