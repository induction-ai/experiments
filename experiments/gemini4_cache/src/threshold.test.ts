import { describe, expect, it } from "@experiments/test";
import { chunks, MANY, plan } from "./threshold.js";

const words = (s: string | undefined) => (s ?? "").split(/\s+/).length;

describe("threshold shapes", () => {
  it("every shape carries the same filler, split across its messages", () => {
    for (const [shape, n] of [
      ["one", 1],
      ["two_cold", 2],
      ["many_grown", MANY],
    ] as const) {
      const c = chunks(shape, 8000, 7, "abc");
      expect(c).toHaveLength(n);
      const total = c.reduce((t, m) => t + words(m.parts[0]!.text), 0);
      // Headers: "Reference <nonce>." on the first, "Reference part k." after.
      expect(total).toBe(8000 + 2 + 3 * (n - 1));
    }
  });

  it("messages alternate user/model, starting with user", () => {
    const roles = chunks("many_cold", 800, 1, "x").map((c) => c.role);
    expect(roles).toEqual(
      Array.from({ length: MANY }, (_, i) => (i % 2 ? "model" : "user"))
    );
  });

  it("only the nonce differs between two trials with the same seed", () => {
    const a = chunks("two_cold", 400, 3, "aaa");
    const b = chunks("two_cold", 400, 3, "bbb");
    expect(a[0]!.parts[0]!.text).not.toBe(b[0]!.parts[0]!.text);
    expect(a[0]!.parts[0]!.text!.replace("aaa", "bbb")).toBe(
      b[0]!.parts[0]!.text
    );
    expect(a[1]).toEqual(b[1]);
  });

  it("cold shapes send only the final request", () => {
    expect(plan("one", 100, 1, "n").warmups).toHaveLength(0);
    expect(plan("many_cold", 100, 1, "n").warmups).toHaveLength(0);
  });

  it("grown shapes send each earlier prefix that ends in a user message", () => {
    const { warmups, final } = plan("many_grown", 800, 1, "n");
    expect(warmups).toHaveLength(MANY / 2);
    warmups.forEach((w, i) => {
      expect(w.contents).toHaveLength(2 * i + 1);
      expect(w.contents.at(-1)!.role).toBe("user");
    });
    // Each warm-up is a strict prefix of the final request.
    const last = warmups.at(-1)!.contents;
    expect(final.contents.slice(0, last.length - 1)).toEqual(last.slice(0, -1));
    expect(final.contents.at(-1)!.role).toBe("user");
  });

  it("the final request ends with the question", () => {
    for (const shape of ["one", "two_grown"] as const) {
      const parts = plan(shape, 100, 1, "n").final.contents.at(-1)!.parts;
      expect(parts.at(-1)!.text).toMatch(/single word OK/);
    }
  });
});
