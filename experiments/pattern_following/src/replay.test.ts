import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@experiments/test";
import {
  countCalls,
  countStubbed,
  hasStub,
  spreadEvenly,
  stubArguments,
  stubLastCalls,
  toolTurnCuts,
} from "./replay.js";
import type { InputItem } from "./responses.js";

const call = (name: string, args: string, call_id = name): InputItem => ({
  type: "function_call",
  name,
  arguments: args,
  call_id,
});
const output = (call_id: string): InputItem => ({
  type: "function_call_output",
  call_id,
  output: "ok",
});
const reasoning: InputItem = { type: "reasoning" };
const user: InputItem = { role: "user", content: "hi" };

describe("toolTurnCuts", () => {
  it("cuts before each batch of calls and the reasoning that led into it", () => {
    const input = [
      user,
      reasoning,
      call("a", "{}", "1"),
      call("b", "{}", "2"),
      output("1"),
      output("2"),
      reasoning,
      call("c", "{}", "3"),
      output("3"),
    ];
    expect(toolTurnCuts(input)).toEqual([1, 6]);
  });
});

describe("spreadEvenly", () => {
  it("keeps everything when there are few enough", () => {
    expect(spreadEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("keeps the first and last and spaces the rest evenly", () => {
    expect(spreadEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8], 3)).toEqual([0, 4, 8]);
  });
});

describe("stubArguments", () => {
  const input = [
    user,
    call("lookup", '{"user_id":"u1","date":"2025-01-01"}', "1"),
    output("1"),
    call("time", "{}", "2"),
    output("2"),
    call("search", '{"query":"cash back"}', "3"),
    output("3"),
  ];

  it("replaces every argument value of every call with ...", () => {
    const stubbed = stubArguments(input, 0);
    expect(stubbed[1]!.arguments).toBe('{"user_id":"...","date":"..."}');
    expect(stubbed[5]!.arguments).toBe('{"query":"..."}');
  });

  it("leaves calls without arguments and all results untouched", () => {
    const stubbed = stubArguments(input, 0);
    expect(stubbed[3]).toEqual(input[3]);
    expect(stubbed.filter((i) => i.type !== "function_call")).toEqual(
      input.filter((i) => i.type !== "function_call")
    );
  });

  it("keeps the most recent calls intact", () => {
    const stubbed = stubArguments(input, 1);
    expect(stubbed[1]!.arguments).toBe('{"user_id":"...","date":"..."}');
    expect(stubbed[5]).toEqual(input[5]);
  });

  it("can stub only the most recent calls, leaving older ones intact", () => {
    const stubbed = stubLastCalls(input, 2);
    expect(stubbed[1]).toEqual(input[1]);
    expect(stubbed[3]).toEqual(input[3]);
    expect(stubbed[5]!.arguments).toBe('{"query":"..."}');
  });

  it("counts calls and stubbed calls", () => {
    expect(countCalls(input)).toBe(3);
    expect(countStubbed(input)).toBe(0);
    expect(countStubbed(stubArguments(input, 0))).toBe(2);
  });
});

describe("hasStub", () => {
  it("spots ... as any argument value or as the whole arguments", () => {
    expect(hasStub('{"query":"..."}')).toBe(true);
    expect(hasStub('{"user_id":"u1","date":" ... "}')).toBe(true);
    expect(hasStub("...")).toBe(true);
  });

  it("does not count ... inside a longer value", () => {
    expect(hasStub('{"query":"cash back ... rules"}')).toBe(false);
    expect(hasStub("{}")).toBe(false);
  });
});

describe("the saved trajectories", () => {
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../data/trajectories"
  );
  it.each(fs.readdirSync(dir).filter((f) => f.endsWith(".json")))(
    "%s has a tool turn to replay at every cut, with nothing stubbed yet",
    (file) => {
      const { input } = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8")
      ) as { input: InputItem[] };
      const cuts = toolTurnCuts(input);
      expect(cuts.length).toBeGreaterThanOrEqual(12);
      for (const cut of cuts) {
        const next = input.slice(cut).find((i) => i.type !== "reasoning");
        expect(next?.type).toBe("function_call");
      }
      expect(countStubbed(input)).toBe(0);
    }
  );
});
