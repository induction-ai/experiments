import fs from "node:fs";

type Cell = string | number | boolean | null | undefined;

function quote(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvLine(values: Cell[]): string {
  return values.map(quote).join(",");
}

/**
 * Append rows to a CSV, writing the header first if the file is new. Every
 * script appends, so re-running with RUNS=N adds N more trials per condition.
 */
export function appendRows(
  file: string,
  columns: readonly string[],
  rows: Record<string, Cell>[]
): void {
  if (rows.length === 0) return;
  let out = "";
  if (!fs.existsSync(file)) out += toCsvLine([...columns]) + "\n";
  else {
    const header = fs.readFileSync(file, "utf8").split("\n", 1)[0];
    if (header !== toCsvLine([...columns])) {
      throw new Error(
        `${file} has different columns; re-run with FRESH=true to start over.`
      );
    }
  }
  for (const r of rows) out += toCsvLine(columns.map((c) => r[c])) + "\n";
  fs.appendFileSync(file, out);
}

export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const [header, ...body] = records;
  if (!header) return [];
  return body.map((r) =>
    Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))
  );
}
