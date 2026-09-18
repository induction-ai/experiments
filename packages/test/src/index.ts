import { it as vitestIt, type TaskCustomOptions, type TestAPI } from "vitest";
import { recordHttp } from "./record.js";

type Fn = (...args: never[]) => void | Promise<void>;
type Arg = number | TaskCustomOptions | Fn | undefined;

// vitest accepts (name, fn, options | timeout) and (name, options, fn).
function split(arg1: Arg, arg2: Arg): { fn?: Fn; options?: TaskCustomOptions } {
  const asOptions = (a: Arg) =>
    typeof a === "number" ? { timeout: a } : (a as TaskCustomOptions);
  if (typeof arg1 === "function") return { fn: arg1, options: asOptions(arg2) };
  return {
    fn: typeof arg2 === "function" ? arg2 : undefined,
    options: asOptions(arg1),
  };
}

const record =
  (fn: Fn) =>
  async (...args: never[]) => {
    await recordHttp(async () => {
      await fn(...args);
    });
  };

type Base = typeof vitestIt | typeof vitestIt.only;

/**
 * Wrap one flavour of vitest's `it` (plain, `.only`, `.concurrent`) so every
 * test body, including each row of `.each`, runs inside `recordHttp`.
 */
function wrap(base: Base) {
  function wrapped(name: string, arg1?: Arg, arg2?: Arg): void {
    const { fn, options } = split(arg1, arg2);
    // No body (e.g. a bare `it("pending")`): pass through.
    if (!fn) return base(name, options);
    base(name, options, record(fn));
  }
  wrapped.each =
    (table: unknown) =>
    (name: string, arg1?: Arg, arg2?: Arg): void => {
      const { fn, options } = split(arg1, arg2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (base.each as any)(table)(name, options ?? {}, record(fn!));
    };
  return wrapped;
}

/**
 * Drop-in replacement for vitest's `it` that auto-wraps the test body in
 * `recordHttp`. On `RECORD=true`, real HTTP responses are captured to the
 * workspace's `test/__recordings__/` tree; otherwise Polly replays them.
 *
 * `.each`, `.only` and `.concurrent` (and `.only.each` etc.) record too;
 * `.skip` and `.todo` pass through, since they never run a body.
 */
const wrappedIt = wrap(vitestIt);
Object.setPrototypeOf(wrappedIt, vitestIt);
Object.assign(wrappedIt, vitestIt);
// vitest exposes these as read-only accessors, so define rather than assign.
for (const [key, value] of Object.entries({
  each: wrap(vitestIt).each,
  only: wrap(vitestIt.only),
  concurrent: wrap(vitestIt.concurrent),
})) {
  Object.defineProperty(wrappedIt, key, { value, configurable: true });
}

export const it = wrappedIt as unknown as TestAPI;

export { recordedValue, recordHttp } from "./record.js";
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
} from "vitest";
