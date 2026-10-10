import type { InputItem } from "./responses.js";

export const STUB = "...";

const isCall = (item: InputItem | undefined) => item?.type === "function_call";

/**
 * The points in a trajectory where the agent's next move was a batch of tool
 * calls: for each batch, the index where the history is cut, before the batch
 * and before any reasoning items that led into it.
 */
export function toolTurnCuts(input: InputItem[]): number[] {
  const cuts: number[] = [];
  input.forEach((item, i) => {
    if (!isCall(item) || isCall(input[i - 1])) return;
    let cut = i;
    while (input[cut - 1]?.type === "reasoning") cut--;
    cuts.push(cut);
  });
  return cuts;
}

/** Up to `max` items of `xs`, evenly spaced, always keeping the first and last. */
export function spreadEvenly<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  return Array.from(
    { length: max },
    (_, k) => xs[Math.round((k * (xs.length - 1)) / (max - 1))]!
  );
}

/** Replaces every top-level argument value with `...`. */
function stubbed(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(
        Object.fromEntries(Object.keys(parsed).map((key) => [key, STUB]))
      );
    }
  } catch {
    // Unreadable arguments are stubbed whole.
  }
  return STUB;
}

/**
 * Stubs the arguments of every tool call in `input` except the `keepLast`
 * most recent ones. Calls without arguments stay as they are.
 */
export function stubArguments(
  input: InputItem[],
  keepLast: number
): InputItem[] {
  const callIndexes = input.flatMap((item, i) => (isCall(item) ? [i] : []));
  return stubAt(
    input,
    callIndexes.slice(0, Math.max(0, callIndexes.length - keepLast))
  );
}

/** Stubs the arguments of only the `count` most recent tool calls. */
export function stubLastCalls(input: InputItem[], count: number): InputItem[] {
  const callIndexes = input.flatMap((item, i) => (isCall(item) ? [i] : []));
  return stubAt(input, callIndexes.slice(-count));
}

function stubAt(input: InputItem[], indexes: number[]): InputItem[] {
  const stub = new Set(indexes);
  return input.map((item, i) =>
    stub.has(i)
      ? { ...item, arguments: stubbed(item.arguments as string) }
      : item
  );
}

/** True when a call's arguments contain a stub: `...` as a value, or whole. */
export function hasStub(args: string): boolean {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.values(parsed).some(
        (v) => typeof v === "string" && v.trim() === STUB
      );
    }
  } catch {
    // Not JSON: fall through to the whole-string check.
  }
  return args.trim() === STUB;
}

export const countCalls = (input: InputItem[]) => input.filter(isCall).length;

/** Calls whose arguments carry a stub. */
export const countStubbed = (input: InputItem[]) =>
  input.filter((item) => isCall(item) && hasStub(item.arguments as string))
    .length;
