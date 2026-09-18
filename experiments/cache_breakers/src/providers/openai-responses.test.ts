import { describe, expect, it } from "@experiments/test";
import { buildFixture } from "../fixture.js";
import { runTrial } from "../trial.js";
import {
  openaiResponses,
  openaiResponsesToolLoop,
  parseResponsesUsage,
  renderResponses,
  responsesVariants,
} from "./openai-responses.js";
import type { Json } from "./types.js";

const fixture = buildFixture({ seed: 1, nonce: "n0", sectionWords: 200 });
const base = renderResponses(fixture, "gpt-5.6-sol");
const ctx = { fixture, altModel: "gpt-5.6-luna" };

describe("renderResponses", () => {
  it("lays sections out as tools, instructions, then five input messages", () => {
    expect(base.instructions).toBe(fixture.system);
    expect((base.tools as Json[]).length).toBe(fixture.tools.length);
    const input = base.input as Json[];
    expect(input.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(input[4]!.content).toBe(fixture.final);
    expect(base.prompt_cache_key).toBe("n0");
  });
});

describe("variants", () => {
  it("have unique names", () => {
    const names = responsesVariants.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("change the serialised body, except the control", () => {
    for (const v of responsesVariants) {
      const start = v.rebase ? v.rebase(structuredClone(base)) : base;
      // Compare serialised JSON: key order is part of what gets sent.
      const wire = JSON.stringify(start);
      const out = JSON.stringify(v.apply(structuredClone(start), ctx));
      // Variants whose change is an extra request return to the base.
      const changesInPrewarm = v.name === "control" || !!v.prewarm?.length;
      if (changesInPrewarm && out === wire) continue;
      expect(out, v.name).not.toBe(wire);
    }
  });

  it("effort pairs warm at one level and send another", () => {
    const pairs = responsesVariants.filter((v) =>
      /^effort_\w+_to_\w+$/.test(v.name)
    );
    expect(pairs).toHaveLength(6 * 5 - 2);
    const v = pairs.find((x) => x.name === "effort_high_to_max")!;
    const warmed = v.rebase!(structuredClone(base));
    expect(warmed.reasoning).toEqual({ effort: "high" });
    expect(v.apply(structuredClone(warmed), ctx).reasoning).toEqual({
      effort: "max",
    });
  });

  it("never mutate the base they were given a copy of", () => {
    const before = structuredClone(base);
    for (const v of responsesVariants) v.apply(structuredClone(base), ctx);
    expect(base).toEqual(before);
  });
});

describe("prewarm probes", () => {
  it("send the previous turn: input up to the late user message", () => {
    const v = responsesVariants.find(
      (x) => x.name === "prev_turn_then_final_edit"
    )!;
    const [prev] = v.prewarm!(structuredClone(base), ctx);
    const input = prev!.input as Json[];
    expect(input).toEqual((base.input as Json[]).slice(0, 3));
    expect(prev!.instructions).toBe(base.instructions);
  });
});

describe("tool-loop variants", () => {
  // Shape of a replayed turn, as buildToolLoopBase assembles it.
  const loopBase: Json = {
    ...base,
    input: [
      ...(base.input as Json[]),
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "e" },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "t",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ],
  };
  const loopCtx = { ...ctx, seed: { id: "resp_1" } };
  const apply = (name: string) =>
    openaiResponsesToolLoop.variants
      .find((v) => v.name === name)!
      .apply(structuredClone(loopBase), loopCtx);
  const types = (b: Json) => (b.input as Json[]).map((i) => i.type ?? i.role);

  it("drop_reasoning_strip_ids removes the reasoning item and every id", () => {
    const out = apply("drop_reasoning_strip_ids");
    expect(types(out)).not.toContain("reasoning");
    expect((out.input as Json[]).some((i) => "id" in i)).toBe(false);
  });

  it("reasoning_by_reference swaps only the reasoning item", () => {
    const input = apply("reasoning_by_reference").input as Json[];
    expect(input).toContainEqual({ type: "item_reference", id: "rs_1" });
    expect(input.some((i) => i.id === "fc_1")).toBe(true);
  });

  it("previous_response_id sends only the tool result", () => {
    const out = apply("previous_response_id");
    expect(out.previous_response_id).toBe("resp_1");
    expect(types(out)).toEqual(["function_call_output"]);
    expect(out.tools).toEqual(loopBase.tools);
  });

  it("then_user_turn appends after the tool result", () => {
    expect(types(apply("then_user_turn")).slice(-3)).toEqual([
      "function_call_output",
      "assistant",
      "user",
    ]);
  });

  it("every variant except control changes the wire body", () => {
    const wire = JSON.stringify(loopBase);
    for (const v of openaiResponsesToolLoop.variants) {
      const out = JSON.stringify(v.apply(structuredClone(loopBase), loopCtx));
      if (v.name === "control") expect(out).toBe(wire);
      else expect(out, v.name).not.toBe(wire);
    }
  });
});

describe("parseResponsesUsage", () => {
  it("reads cached, written and reasoning tokens", () => {
    expect(
      parseResponsesUsage({
        usage: {
          input_tokens: 3021,
          input_tokens_details: { cached_tokens: 3018, cache_write_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      })
    ).toEqual({
      input: 3021,
      cached: 3018,
      cacheWrite: 0,
      output: 5,
      reasoning: 0,
    });
  });

  it("returns null without usage", () => {
    expect(parseResponsesUsage({})).toBeNull();
  });
});

describe("runTrial (live, recorded)", () => {
  it("warms the base and reads a full hit on the control", async () => {
    const control = responsesVariants.find((v) => v.name === "control")!;
    const row = await runTrial(openaiResponses, control, {
      seed: 42,
      nonce: "test-control-2",
      model: "gpt-5.6-sol",
      sectionWords: 1500,
      maxWarm: 4,
      delayMs: process.env.RECORD ? 1500 : 0,
    });
    expect(row.error).toBe("");
    expect(row.first_cached).toBe(0);
    expect(row.warmed).toBe(true);
    expect(row.cached).toBe(row.base_cached);
  }, 60_000);

  it("keeps only the header when the final message changes", async () => {
    const v = responsesVariants.find((x) => x.name === "final_edit")!;
    const row = await runTrial(openaiResponses, v, {
      seed: 43,
      nonce: "test-final-2",
      model: "gpt-5.6-sol",
      sectionWords: 1500,
      maxWarm: 4,
      delayMs: process.env.RECORD ? 1500 : 0,
    });
    expect(row.warmed).toBe(true);
    expect(row.cached).toBeGreaterThan(0);
    expect(row.cached!).toBeLessThan(row.base_cached! - 1000);
  }, 60_000);
});

describe("tool loop (live, recorded)", () => {
  it("seeds a turn with a reasoning item and reads a full hit on control", async () => {
    const control = openaiResponsesToolLoop.variants.find(
      (v) => v.name === "control"
    )!;
    const row = await runTrial(
      openaiResponses,
      control,
      {
        seed: 44,
        nonce: "test-loop-1",
        model: "gpt-5.6-sol",
        sectionWords: 1500,
        maxWarm: 4,
        delayMs: process.env.RECORD ? 1500 : 0,
      },
      "tool_loop"
    );
    expect(row.error).toBe("");
    expect(row.warmed).toBe(true);
    expect(row.cached).toBe(row.base_cached);
  }, 120_000);
});
