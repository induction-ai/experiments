/** Run `tasks` with at most `limit` in flight, preserving result order. */
export async function pool<T>(
  limit: number,
  tasks: (() => Promise<T>)[]
): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
  return out;
}
