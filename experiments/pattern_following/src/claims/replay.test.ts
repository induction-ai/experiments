// Claims from blog.md experiment 1: real tau-banking trajectories replayed
// with their past tool-call arguments stubbed. One turn, banking_056_a turn 3,
// stands in for the full run (results/replay/banking.csv).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@experiments/test";
import {
  spreadEvenly,
  stubArguments,
  stubLastCalls,
  toolTurnCuts,
} from "../replay.js";
import type { CapturedRequest } from "../trials.js";
import { sample, TIMEOUT } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function point(name: string, turn: number) {
  const trajectory = JSON.parse(
    fs.readFileSync(
      path.join(here, `../../data/trajectories/${name}.json`),
      "utf8"
    )
  ) as CapturedRequest;
  const cut = spreadEvenly(toolTurnCuts(trajectory.input), 12)[turn]!;
  return { trajectory, history: trajectory.input.slice(0, cut) };
}

const { trajectory, history } = point("banking_056_a", 3);

describe("stubbing real trajectories", () => {
  it(
    "with its history as recorded, the agent never writes a stub",
    async () => {
      const replies = await sample(history, 2, trajectory);
      for (const r of replies) expect(r.stubbed_calls).toBe(0);
    },
    TIMEOUT
  );

  it(
    "with every past call stubbed, the agent writes stubs into its next calls",
    async () => {
      const replies = await sample(stubArguments(history, 0), 3, trajectory);
      expect(
        replies.filter((r) => r.stubbed_calls > 0).length
      ).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT
  );

  it(
    "keeping the last 3 calls intact stops the agent writing stubs",
    async () => {
      const replies = await sample(stubArguments(history, 3), 2, trajectory);
      for (const r of replies) expect(r.stubbed_calls).toBe(0);
    },
    TIMEOUT
  );

  it(
    "with only the last 3 calls stubbed and a long normal history, the agent can still write a stub",
    async () => {
      // banking_055_a turn 11: 42 older calls as recorded, the last 3 stubbed.
      const late = point("banking_055_a", 11);
      const replies = await sample(
        stubLastCalls(late.history, 3),
        3,
        late.trajectory
      );
      expect(
        replies.filter((r) => r.stubbed_calls > 0).length
      ).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT
  );
});
