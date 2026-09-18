import { it as vitestIt, type TaskCustomOptions, type TestAPI } from "vitest";
import { recordHttp } from "./record.js";

/**
 * Drop-in replacement for vitest's `it` that auto-wraps the test body in
 * `recordHttp`. On `RECORD=true`, real HTTP responses are captured to the
 * workspace's `test/__recordings__/` tree; otherwise Polly replays them.
 *
 * All vitest `it` methods (`.only`, `.skip`, `.todo`, `.concurrent`, `.each`)
 * are preserved.
 */
function wrappedIt(
  name: string,
  arg1?: TaskCustomOptions | (() => void | Promise<void>),
  arg2?: () => void | Promise<void>
): void {
  let options: TaskCustomOptions | undefined;
  let fn: (() => void | Promise<void>) | undefined;

  if (typeof arg1 === "function") {
    fn = arg1;
    options = arg2 as TaskCustomOptions | undefined;
  } else {
    options = arg1;
    fn = arg2;
  }

  if (!fn) {
    // No body (e.g. `it.todo("...")` or a bare `it("pending")`) — pass through.
    vitestIt(name, options);
    return;
  }

  const run = fn;
  const wrapped = async () => {
    await recordHttp(async () => {
      await run();
    });
  };

  vitestIt(name, options, wrapped);
}

// Preserve `.only`, `.skip`, `.todo`, `.concurrent`, `.each`, etc.
Object.setPrototypeOf(wrappedIt, vitestIt);
Object.assign(wrappedIt, vitestIt);

export const it = wrappedIt as TestAPI;

export { recordHttp } from "./record.js";
export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  vi,
} from "vitest";
