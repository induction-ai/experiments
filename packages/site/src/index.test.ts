import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@experiments/test";
import {
  dateLine,
  formatDate,
  parseExperiment,
  readExperiments,
  renderIndex,
} from "./index.js";

const BLOG = `# Does \`x\` break the cache?

First line of the summary,
second line of the summary.

## Method
`;

const LOG = `# x log

## 2026-09-18: later entry

## 2026-09-02: first entry
`;

describe("parseExperiment", () => {
  it("takes the title and first paragraph from the blog", () => {
    const e = parseExperiment("x", BLOG, LOG);
    expect(e.title).toBe("Does <code>x</code> break the cache?");
    expect(e.summary).toBe(
      "First line of the summary, second line of the summary."
    );
  });

  it("takes the earliest and latest dated headings from the log", () => {
    const e = parseExperiment("x", BLOG, LOG);
    expect(e.started).toBe("2026-09-02");
    expect(e.updated).toBe("2026-09-18");
  });

  it("throws when the blog has no title or the log has no dates", () => {
    expect(() => parseExperiment("x", "no title", LOG)).toThrow(/title/);
    expect(() => parseExperiment("x", BLOG, "# log\n")).toThrow(/YYYY-MM-DD/);
  });
});

describe("dates", () => {
  it("formats ISO dates as day, short month, year", () => {
    expect(formatDate("2026-09-02")).toBe("2 Sep 2026");
  });

  it("shows one date when started and updated match, else a range", () => {
    const e = parseExperiment("x", BLOG, LOG);
    expect(dateLine({ ...e, started: e.updated })).not.toContain(" to ");
    expect(dateLine(e)).toContain("2 Sep 2026</time> to <time");
  });
});

describe("readExperiments", () => {
  it("lists folders with a blog and a log, most recently updated first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
    const write = (name: string, date: string) => {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "blog.md"), `# ${name}\n`);
      fs.writeFileSync(path.join(dir, name, "log.md"), `## ${date}: start\n`);
    };
    write("older", "2026-01-01");
    write("newer", "2026-06-01");
    fs.mkdirSync(path.join(dir, "no_blog"));

    expect(readExperiments(dir).map((e) => e.name)).toEqual(["newer", "older"]);
  });

  it("links each experiment's page and log from the site root", () => {
    const html = renderIndex([parseExperiment("x", BLOG, LOG)]);
    expect(html).toContain('<a href="experiments/x/">');
    expect(html).toContain('<a href="experiments/x/log.html">log</a>');
  });
});
