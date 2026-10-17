// Synthetic, seeded prompt content. Nothing here comes from a real product:
// every prompt is filler drawn from a fixed vocabulary of common English
// words, so sizes are predictable and no real data is sent.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = (
  "river stone copper maple orbit lantern quiet harbor signal timber violet " +
  "garden window market silver engine forest winter candle bridge meadow " +
  "pocket thunder canvas rocket shadow marble falcon cotton island mirror " +
  "anchor basket feather planet ladder saddle helmet ribbon valley cabin " +
  "orange yellow purple simple gentle rapid narrow hollow steady golden " +
  "table paper field music story letter number circle square corner"
).split(" ");

export function words(rng: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(VOCAB[Math.floor(rng() * VOCAB.length)]!);
  }
  return out.join(" ");
}

/**
 * `n` words of filler led by a nonce, so no two trials share a prefix (and a
 * live run can never hit a cache left by an earlier one).
 */
export function filler(seed: number, nonce: string, n: number): string {
  return `Reference ${nonce}.\n${words(mulberry32(seed), n)}`;
}
