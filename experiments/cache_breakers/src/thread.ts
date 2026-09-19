// A realistic multi-turn thread: every turn is sent, so every earlier
// request leaves its own end in the cache. Then one probe edits or branches
// the thread, and the cached count tells apart three rules for what is
// reusable: the end of an earlier request, any message boundary (longest
// prefix), or any 128-token block.
import { book, buildFixture, editEnd, mulberry32, words } from "./fixture.js";
import type { Adapter, Json } from "./providers/types.js";

export const THREAD_PROBES = [
  "edit_u4",
  "branch_at_u4",
  "truncate_after_a4",
  "edit_u4_after_60s",
  "edit_a4",
] as const;
export type ThreadProbe = (typeof THREAD_PROBES)[number];

export interface ThreadRow {
  provider: string;
  model: string;
  probe: ThreadProbe;
  seed: number;
  nonce: string;
  turns: number;
  /** Prompt tokens of each turn's request, `;`-joined (R1..Rn). */
  request_tokens: string;
  /** Cached tokens on each turn's request, `;`-joined. */
  request_cached: string;
  /** Cached count if only earlier requests' ends are reusable. */
  predict_request_end: number | null;
  /** End of the next request: a longest-prefix rule lands between the two. */
  next_request_end: number | null;
  probe_input: number | null;
  probe_cached: number | null;
  error: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/**
 * Run one thread trial. Turn k's request is [u1, a1, …, uk]. Assistant
 * replies are fixed text (not generated), long enough that the rules'
 * predictions differ by hundreds of tokens.
 */
export async function runThread(
  adapter: Adapter,
  probe: ThreadProbe,
  opts: {
    model: string;
    seed: number;
    nonce: string;
    turns: number;
    userWords: number;
    replyWords: number;
    delayMs: number;
  }
): Promise<ThreadRow> {
  const f = buildFixture({
    seed: opts.seed,
    nonce: opts.nonce,
    sectionWords: 600,
    style: adapter.fillerStyle,
  });
  const base = adapter.render(f, opts.model);
  const key = "input" in base ? "input" : "messages";
  const rng = mulberry32(opts.seed + 99);
  const fill = adapter.fillerStyle === "book" ? book : words;
  const msgs: Msg[] = [];
  for (let k = 1; k <= opts.turns; k++) {
    msgs.push({
      role: "user",
      content: `[${opts.nonce}] Turn ${k}. ${fill(rng, opts.userWords)}`,
    });
    msgs.push({ role: "assistant", content: fill(rng, opts.replyWords) });
  }
  // With explicit Anthropic breakpoints (tools and system already marked by
  // render), the thread moves one more marker onto each request's last
  // message, the usual way to cache a growing conversation.
  const marked = adapter.name === "anthropic_breakpoints";
  const body = (input: Msg[]): Json => ({
    ...base,
    [key]: marked
      ? input.map((m, i) =>
          i === input.length - 1
            ? {
                role: m.role,
                content: [
                  {
                    type: "text",
                    text: m.content,
                    cache_control: { type: "ephemeral" },
                  },
                ],
              }
            : m
        )
      : input,
  });
  // u_k is msgs[2k-2], a_k is msgs[2k-1]; request k ends with u_k.
  const request = (k: number) => msgs.slice(0, 2 * k - 1);

  const row: ThreadRow = {
    provider: adapter.name,
    model: opts.model,
    probe,
    seed: opts.seed,
    nonce: opts.nonce,
    turns: opts.turns,
    request_tokens: "",
    request_cached: "",
    predict_request_end: null,
    next_request_end: null,
    probe_input: null,
    probe_cached: null,
    error: "",
  };

  const sizes: number[] = [];
  const cached: number[] = [];
  for (let k = 1; k <= opts.turns; k++) {
    if (k > 1) await sleep(opts.delayMs);
    const r = await adapter.send(body(request(k)));
    if (r.error || !r.usage) {
      row.error = `turn ${k}: ${r.error ?? "no usage"}`;
      return row;
    }
    sizes.push(r.usage.input);
    cached.push(r.usage.cached);
  }
  row.request_tokens = sizes.join(";");
  row.request_cached = cached.join(";");

  // Request k+1 read all of request k when the thread grew normally, so
  // cached[k] (0-based: request k+1's read) is request k's reusable end.
  const end = (k: number) => cached[k] ?? 0;
  let probeInput: Msg[];
  const edited = (m: Msg): Msg => ({ ...m, content: editEnd(m.content) });
  switch (probe) {
    case "edit_u4":
    case "edit_u4_after_60s":
      probeInput = [...request(opts.turns)];
      probeInput[6] = edited(probeInput[6]!);
      break;
    case "branch_at_u4":
      probeInput = [
        ...msgs.slice(0, 6),
        {
          role: "user",
          content: `[${opts.nonce}] A different question. ${fill(rng, opts.userWords)}`,
        },
      ];
      break;
    case "edit_a4":
      probeInput = [...request(opts.turns)];
      probeInput[7] = edited(probeInput[7]!);
      break;
    case "truncate_after_a4":
      probeInput = [
        ...msgs.slice(0, 8),
        {
          role: "user",
          content: `[${opts.nonce}] New direction. Reply with ok.`,
        },
      ];
      break;
  }
  // The edit/branch probes change u4, so request 3 (u1..u3) is intact and
  // a3 follows it; truncate keeps request 4 intact and a4 follows it.
  // Request-end rule: the probe reads exactly end(intact). A longest-prefix
  // or message-boundary rule would also read the following assistant reply,
  // i.e. land between end(intact) and end(intact + 1).
  const intact = probe === "truncate_after_a4" || probe === "edit_a4" ? 4 : 3;
  row.predict_request_end = end(intact);
  row.next_request_end = end(intact + 1);

  await sleep(probe === "edit_u4_after_60s" ? 60_000 : opts.delayMs);
  const p = await adapter.send(body(probeInput));
  if (p.error || !p.usage) {
    row.error = `probe: ${p.error ?? "no usage"}`;
    return row;
  }
  row.probe_input = p.usage.input;
  row.probe_cached = p.usage.cached;
  return row;
}
