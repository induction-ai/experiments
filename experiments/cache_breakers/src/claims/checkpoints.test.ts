// Claims from blog.md § 1 and § 5: the cache reuses whole blocks, and the
// only reusable points are the end of the header and the end of an earlier
// request. OpenAI Responses, gpt-5.6-sol.
import { describe, expect, it } from "@experiments/test";
import {
  expectFallback,
  expectFull,
  expectZero,
  headerOnlyBody,
  near,
  sendOnce,
  TIMEOUT,
  trial,
} from "./helpers.js";

describe("checkpoints", () => {
  it(
    "control: resending the warm request unchanged reuses everything",
    async () => {
      expectFull(await trial("control"));
    },
    TIMEOUT
  );

  it(
    "an edit at the start or end of the system prompt reuses nothing",
    async () => {
      expectZero(await trial("system_edit_start"));
      expectZero(await trial("system_edit_end"));
    },
    TIMEOUT
  );

  it(
    "an edit at the start or end of the tools reuses nothing",
    async () => {
      expectZero(await trial("tools_edit_start"));
      expectZero(await trial("tools_edit_end"));
    },
    TIMEOUT
  );

  it(
    "a system prompt edit reuses nothing even with ~8000 unchanged tokens before it",
    async () => {
      const row = await trial("system_edit_end", { sectionWords: 4000 });
      expectZero(row);
      expect(row.base_cached!).toBeGreaterThan(15_000);
    },
    TIMEOUT
  );

  it(
    "any history edit, even to the last message, falls back to the end of tools + instructions",
    async () => {
      const early = await trial("early_edit_start");
      const late = await trial("late_edit_end");
      const final = await trial("final_edit");
      for (const r of [early, late, final]) expectFallback(r);
      // All three land on the same point...
      near(late.cached!, early.cached!);
      near(final.cached!, early.cached!);
      // ...and that point is the size of a request holding only the tools,
      // the instructions and a tiny user message.
      const headerOnly = await sendOnce(headerOnlyBody());
      near(early.cached!, headerOnly.input, 40);
      // The whole history after it is written again.
      expect(final.cache_write!).toBeGreaterThan(2500);
    },
    TIMEOUT
  );

  it(
    "after the previous turn has been sent, an edit falls back to that turn's end instead",
    async () => {
      const header = await trial("final_edit");
      const prev = await trial("prev_turn_then_final_edit");
      expectFallback(prev);
      expect(prev.cached!).toBeGreaterThan(header.cached! + 1500);
    },
    TIMEOUT
  );

  it(
    "a sibling request that diverges after the shared history gives no extra reuse",
    async () => {
      const header = await trial("final_edit");
      const sibling = await trial("sibling_then_late_edit");
      expectFallback(sibling);
      near(sibling.cached!, header.cached!);
    },
    TIMEOUT
  );

  it(
    "appending a turn (normal conversation growth) reuses everything before it",
    async () => {
      expectFull(await trial("append_turn"));
    },
    TIMEOUT
  );

  it(
    "an image in the final message falls back like any other final-message edit",
    async () => {
      const header = await trial("final_edit");
      const image = await trial("image_in_final");
      expectFallback(image);
      near(image.cached!, header.cached!);
    },
    TIMEOUT
  );
});
