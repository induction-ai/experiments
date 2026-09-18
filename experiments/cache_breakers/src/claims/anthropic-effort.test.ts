// Claims about reasoning effort on Anthropic Messages (claude-opus-5): every
// change resets the cache, high is the default, and a level's cache survives
// a detour. Automatic caching; ~600-word sections.
import { describe, expect, it } from "@experiments/test";
import {
  ANTHROPIC_EFFORTS,
  anthropicAuto,
  anthropicBreakpoints,
} from "../providers/anthropic-messages.js";
import { expectFull, expectZero, TIMEOUT, trial } from "./helpers.js";

const auto = (name: string) =>
  trial(name, { adapter: anthropicAuto, sectionWords: 600 });

const pairs = ANTHROPIC_EFFORTS.flatMap((from) =>
  ANTHROPIC_EFFORTS.filter((to) => to !== from).map((to) => [from, to])
);

describe("anthropic reasoning effort", () => {
  it("covers all 20 ordered pairs of the five levels", () => {
    expect(ANTHROPIC_EFFORTS).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(pairs).toHaveLength(20);
  });

  it.each(pairs)(
    "%s → %s reuses nothing",
    async (from, to) => {
      expectZero(await auto(`effort_${from}_to_${to}`));
    },
    TIMEOUT
  );

  it(
    "omitting effort is the same as high: full reuse after high",
    async () => {
      expectFull(await auto("effort_high_omitted"));
    },
    TIMEOUT
  );

  it.each(["low", "medium", "xhigh", "max"])(
    "omitting effort after warming at %s reuses nothing",
    async (level) => {
      expectZero(await auto(`effort_${level}_omitted`));
    },
    TIMEOUT
  );

  it(
    "returning to an earlier level still hits its cache (low → medium → low)",
    async () => {
      expectFull(await auto("effort_switch_back"));
    },
    TIMEOUT
  );

  it(
    "an effort change reuses nothing even with a breakpoint on the tools",
    async () => {
      expectZero(
        await trial("effort_low_to_medium", {
          adapter: anthropicBreakpoints,
          sectionWords: 600,
        })
      );
    },
    TIMEOUT
  );
});
