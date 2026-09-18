import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@experiments/test";
import { appendRows, parseCsv, toCsvLine } from "./csv.js";

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(toCsvLine(["a", 'say "hi"', "x,y", null, 3])).toBe(
      'a,"say ""hi""","x,y",,3'
    );
  });

  it("appends across calls and round-trips", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "csv-")),
      "out.csv"
    );
    const cols = ["a", "b"];
    appendRows(file, cols, [{ a: 1, b: "x,y" }]);
    appendRows(file, cols, [{ a: 2, b: 'q"q\nline' }]);
    expect(parseCsv(fs.readFileSync(file, "utf8"))).toEqual([
      { a: "1", b: "x,y" },
      { a: "2", b: 'q"q\nline' },
    ]);
  });

  it("refuses to append rows with a different header", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "csv-")),
      "out.csv"
    );
    appendRows(file, ["a"], [{ a: 1 }]);
    expect(() => appendRows(file, ["a", "b"], [{ a: 1 }])).toThrow(/FRESH/);
  });
});
