# Does Gemini 4’s implicit cache behave like Gemini 3.1’s?

Gemini caches repeated prompt prefixes automatically and bills the reused tokens at a discount. This experiment measures `gemini-4-argon` side by side with `gemini-3.1-pro-preview`: where caching starts, how much of a request it covers, which earlier requests it can reuse, and whether the 3.x quirks around thought signatures and token counting still hold. For argon it also runs a cache-breaker matrix: one change at a time to a warm request. In a normal, append-only conversation both models reuse nearly every request. Off that path they differ, and Gemini 4 adds a quirk of its own: a hidden 697-token block on some requests that `countTokens` doesn’t see and that costs the whole cache when it appears.

## At a glance

|                                            | `gemini-4-argon`                                                                                       | `gemini-3.1-pro-preview`                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Real thread, every request sent once       | reuses the previous request every time                                                                 | reuses the previous request (29 of 30 steps)                    |
| Smallest request that caches               | sharp, about 4,096 prompt tokens, any shape                                                            | sporadic from about 6,000, reliable from about 9,000            |
| Never cached                               | the last 2,049 tokens of each request                                                                  | the last ~2,043–2,050 tokens of each request                    |
| After appending more than ~2,049 tokens    | the whole previous prompt                                                                              | the whole previous prompt                                       |
| Edit inside the cached part                | reuses nothing                                                                                         | reuses nothing                                                  |
| Edit after the cached part                 | keeps it, if a message boundary comes before the edit; in one long message, loses it                   | keeps it                                                        |
| Which earlier requests can be reused       | any of them                                                                                            | the latest only: a longer request replaces the shorter          |
| Extending past a function call’s signature | no effect (124-byte signatures, never dropped)                                                         | usually loses everything when the signature is far from the end |
| `countTokens`                              | rejects a function call with its signature removed                                                     | never counts the signature                                      |
| Hidden prompt tokens                       | a 697-token block on some multi-message requests                                                       | none                                                            |
| Settings that are part of the cache key    | tools, `thinkingLevel`, JSON mode, toolConfig `NONE`                                                   | not tested                                                      |
| Settings that aren’t                       | temperature, topP, maxOutputTokens, stop sequences, seed, safety settings, toolConfig `ANY` or omitted | not tested                                                      |

## Method

All prompts are seeded filler drawn from a fixed vocabulary of common English words (about one token per word), each led by a fresh nonce, so no real data is sent and no trial can hit a cache left by another. Both models run with `thinkingConfig.thinkingLevel: "low"` through the plain `generateContent` REST endpoint, so the request bytes, including every `thoughtSignature`, are exactly what the scripts build. “Cached” is `usageMetadata.cachedContentTokenCount`.

There are eleven probes. Each has one script that appends one row per trial (or per send) to one CSV, and each can be re-run with `RUNS=N` to add trials:

| Probe            | Script                      | CSV                      | What a trial does                                                                                                                                                     |
| ---------------- | --------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real threads     | `scripts/run-extend.ts`     | `results/extend.csv`     | a 20,000-word opening message, then up to 5 more turns, each request sent once: text replies, a tool loop of signed function calls, or a first reply of chosen length |
| Threshold        | `scripts/run-minimum.ts`    | `results/minimum.csv`    | one total size in five history shapes (below), the final request sent 3–4 times                                                                                       |
| Repeats          | `scripts/run-repeats.ts`    | `results/repeats.csv`    | one message sent 3–6 times, with a one-word or a ~3,000-word reply                                                                                                    |
| Edits            | `scripts/run-edit.ts`       | `results/edit.csv`       | a warm 20,000-word text, as one message or split in two, then one word replaced at 10%, 50%, 90% and 98%                                                              |
| Tail             | `scripts/run-tail.ts`       | `results/tail.csv`       | one request sent twice, with one factor changed from a baseline: content type, thinking level, placement, size                                                        |
| Breakers (argon) | `scripts/run-breakers.ts`   | `results/breakers.csv`   | a warm request with a system instruction, two tools and a four-message history, then one change, sent once                                                            |
| Two turns        | `scripts/run-two-turns.ts`  | `results/two_turns.csv`  | a 10,000-token message, then either your own text (1,700–3,000 words) or a long model reply appended, sent once each                                                  |
| Exact case       | `scripts/run-exact-4100.ts` | `results/exact_4100.csv` | exactly 4,100 (or 4,000) tokens, then exactly 1,000 or 2,100 more, on OpenAI and Gemini                                                                               |
| Earlier requests | `scripts/run-boundary.ts`   | `results/boundary.csv`   | `[u1]`, then `[u1, m1, u2]`, then an edit in `u2` or in `u1`                                                                                                          |
| Signatures       | `scripts/run-sig.ts`        | `results/sig.csv`        | a forced function call after 18,000 words, its response plus 5,000 words, then the thread extended past it                                                            |
| Hidden tokens    | `scripts/run-inflation.ts`  | `results/inflation.csv`  | one request, and a copy whose last word differs, each sent once and counted with `countTokens`                                                                        |

The threshold probe’s five shapes all end in the same final request. `one` puts the filler in a single message. `two_*` split it across a user and a model message, and `many_*` across eight alternating messages. The `*_cold` shapes send only the final request. The `*_grown` shapes first send each earlier turn of the thread, the way a client would as the conversation grew.

## Findings

### In a real conversation, both models reuse nearly every request

When a thread only grows (each request is the previous one plus the model’s real reply and a new user message, sent once), both models reuse the previous request’s cache at every step. A tool loop where every turn is a forced function call with a `thoughtSignature` behaves the same. Each step caches the previous request’s prompt minus a tail of about 2,048 tokens (next section).

<!-- report:chains -->

The misses are all in the table. 3.1 missed one step in 30 of its text and tool threads. In every argon `long_chain` trial, step 2 gained a hidden 697-token block and missed completely (see [the hidden tokens](#gemini-4-sometimes-bills-697-hidden-tokens) below). And one argon `para_chain` trial missed after a 7,507-token reply that grew the next prompt by only 4,649 tokens, as if argon had billed output it didn’t return. We don’t know why. Claim tests: `src/claims/chain.test.ts`.

### Where caching starts

**Gemini 4 has a sharp threshold at about 4,096 prompt tokens, whatever the shape of the history.** Across 90 trials, no request of 4,071 tokens or fewer was ever cached, and every request of 4,135 or more was. Measured in tokens, the edge is the same for one message, two, eight, cold or grown. The few dots that hit at low word counts are requests that argon inflated past 4,096 with its hidden block. The minimum itself probably comes from [the 2,049-token tail](#the-last-2049-tokens-are-never-cached): 4,096 is about 2,049 held back plus 2,048 cached.

**Gemini 3.1’s threshold is fuzzy.** From about 9,000 tokens it cached every trial, in every shape, from the second send. Between 6,000 and 8,000 it sometimes cached, often on only one of four sends (for example 0, 4,248, 0, 0). At about 7,000 it never did.

<!-- report:threshold -->

We expected the history to matter on 3.x: a thread that grew turn by turn past the threshold might cache where the same tokens in one or two big messages, sent cold, would not. These data don’t show that on either model. At 3.1’s edge (8,000 words) the five shapes hit 1, 0, 0, 1 and 1 times out of 3, and argon’s edge is identical across shapes. The grown threads’ earlier turns were themselves below the threshold, so they left nothing to reuse. History does matter, but in a different way: it decides which entries a later request can reuse, which the next sections show. This is three trials per cell on synthetic filler, so a small shape effect on 3.1 can’t be ruled out. Claim tests: `src/claims/threshold.test.ts`.

### The last 2,049 tokens are never cached

When a request is sent, the cache saves its beginning for later reuse: everything except the last 2,049 tokens (on argon; about 2,043–2,050 on 3.1). A later request that starts the same way gets those saved tokens billed as cached, and pays full price for the rest. So:

- **An identical resend** pays full price for exactly its last 2,049 tokens.
- **The next request in a growing thread** pays full price for the previous request’s last 2,049 tokens plus everything appended since, as long as less than 2,049 tokens were appended (more on that below). That’s the “held back” column in the chain table above.

Here is what that looks like on real requests from this experiment. Hover a segment for its size:

<!-- report:tailExamples -->

The 2,049 is measured from the end, not in blocks from the start. A cache built from fixed blocks would report the same cached count for every prompt between two block edges. argon’s count moves one token at a time instead: prompts of 4,150, 4,151 and 4,152 tokens cached 2,101, 2,102 and 2,103. Across 77 distinct prompt sizes, the cached counts fall on 76 different positions within any 2,048-token block. Whatever Google stores internally, the billed count is “all but the last 2,049”. The table below is from identical repeats:

<!-- report:tail -->

To check that 2,049 isn’t an artefact of this setup, one factor at a time was changed from a baseline (filler words in one user message, `thinkingLevel: "low"`, ~8,000 tokens). The tail stayed exactly 2,049 on argon in every case. The 3.1 baseline rows at ~8,000 tokens never cached because they’re below its threshold, so 3.1 was rerun at ~12,000:

<!-- report:tailVariants -->

There is one way past the tail, on both models: **append more than 2,049 tokens.** Each request leaves two points the next request can reuse: its prompt minus the last 2,049 tokens, and the end of its whole prompt (argon: the prompt + 1; 3.1: within a few tokens). The next request can’t reuse anything inside its own last 2,049 tokens, so it gets whichever saved point fits:

- **Less than 2,049 tokens appended:** the end of the previous prompt falls inside the new request’s last 2,049, so only the shorter point is usable. You pay for the previous request’s last 2,049 tokens again.
- **More than 2,049 tokens appended:** the end of the previous prompt is usable, so the whole previous prompt is cached and only what you appended is full price.

There is no partial benefit in between, because there are only those two points. It doesn’t matter whether the appended tokens are the model’s reply or your own text. The `mid_chain` and `para_chain` rows in the chain table show it with replies, and the next section shows it with both. Claim tests: `src/claims/tail.test.ts`, `src/claims/two-turns.test.ts`, and the appended-size cases in `src/claims/chain.test.ts`.

### Two conversations, same size, different bill

Both conversations open with the same 10,000-token message, and both reach about 13,000 tokens on turn 2:

- **A.** The model replies with one word, then you append 3,000 tokens of your own.
- **B.** The model replies with about 3,400 tokens, then you send a one-line follow-up.

In both, turn 2 caches all of turn 1’s prompt, because more than 2,049 tokens were appended. If you appended only ~2,000 tokens instead, turn 2 would cache 2,049 fewer tokens and bill them at full price again. Across both models the edge sits between about 2,030 and 2,115 appended tokens, which fits 2,049.

<!-- report:twoTurns -->

### A small conversation: 4,100 tokens, then 1,000 more

What most people would expect: turn 2 caches the 4,100 tokens of turn 1 and pays full price only for the 1,000 new ones. That isn’t what happens on argon. Turn 2 is about 5,100 tokens, so it can’t use anything after its own token 3,050 or so (its last 2,049 are never served from cache). The end of turn 1, at about 4,100, is past that, so turn 2 falls back to turn 1’s other saved point, turn 1 minus 2,049. It pays full price for about 3,076 tokens: turn 1’s last 2,049 a second time, plus the 1,027 new ones. Append 2,100 instead of 1,000 and the end of turn 1 is usable again, so you get exactly what you’d expect.

<!-- report:smallTurns -->

On 3.1 neither version caches anything: both turns are below its ~9,000-token threshold. The code is the same `src/two-turns.ts` as above, with `openingWords: 4050` and `appendWords: 1000` or `2100`. Claim tests: `src/claims/two-turns.test.ts`.

### The same case at exact sizes, on OpenAI too

`src/exact-4100.ts` runs the case with exact sizes on both OpenAI (`gpt-5.6-sol`) and Gemini 4. Turn 1 is exactly 4,100 prompt tokens (or 4,000). Turn 2 is exactly 1,000 or 2,100 tokens more, reply and new message together. Each request is sized with the provider’s token-counting endpoint, which can’t warm a cache, and checked against the billed count.

<!-- report:exact4100 -->

- **OpenAI resumes at the end of the previous request**, minus 3 tokens, whatever was appended: 4,097 cached after 4,100.
- **Gemini 4 resumes 2,049 tokens before the end** when less than 2,049 is appended (2,051 cached, 3,049 full price), and at the end (+1) when more is (4,101 cached, 2,099 full price).
- **A 4,000-token request saves nothing on Gemini 4**, even when the next request appends 2,100 tokens. The ~4,096 minimum applies to the request, not just to the point 2,049 before its end.

**A third request** (`scripts/run-exact-turn3.ts` → `results/exact_turn3.csv`) adds exactly 1,500 more tokens to each chain. OpenAI again resumes at the end of turn 2, minus 3. On Gemini 4, after 4,100 → +1,000, turn 3 caches only 3,051 (turn 2 minus 2,049), in every completed trial. Turn 1’s end breakpoint (4,100) would have cached more and is within turn 3’s reach, but it is gone: turn 2 had resumed from turn 1’s other point, and turn 1’s end point didn’t survive. So small appends cost 2,049 tokens on every turn, with no way back to an older, better point. After 4,100 → +2,100 → +1,500, turn 3 caches 4,151, and after 4,000 → +2,100 → +1,500 it caches 4,051, both turn 2 minus 2,049.

Gemini blocked a share of turn-2 requests (`blockReason: OTHER`) in this probe but not in the others. The one difference is that this file sends the model’s text reply back without its `thoughtSignature` (to keep the sizes exact), so that is the likely trigger. Claim tests: `src/claims/exact-4100.test.ts`.

### Edits: all or nothing, and argon needs a message boundary

One word replaced in a warm 20,000-token text, at four positions. The text is sent either as one message or split into two messages at 40%:

<!-- report:edit -->

**Both models reuse a stored entry whole or not at all.** An edit inside the part that was cached (10% or 50% of the way in) leaves nothing, not even the tokens before the edit. The 22 tokens at 50% are a tiny entry other requests share. An edit after the cached part (90% or 98%, inside the last 2,049 tokens) keeps all of it.

**argon adds one condition: it can only find a stored entry through the end of a message both requests share.** As one long message, the edited request shares no complete message with the stored one, so even an edit at 98% loses everything, although the cached part is byte-identical. Split into two messages, the first message is shared, and argon keeps the whole entry exactly as 3.1 does. Real requests nearly always have several messages, or a system instruction and tools, before the part that changes. The cache-breaker results below show argon keeping the cache through edits to the latest messages. Claim tests: `src/claims/edit.test.ts`.

### Which earlier requests count

The edit result raises a question: if a request edits its last message, can it still reuse an earlier, shorter request that ended before that message?

<!-- report:boundary -->

- **argon: yes, any of them.** After `[u1]` was sent on its own, a request with `u2` edited reused all of `u1` (its prompt + 1), in 5 of 5 trials. With no earlier `[u1]` request, the same edit reused nothing: the only stored entry, A’s, covers part of `u2`, which the edit changed. argon keeps the shorter entry even after a longer request has extended it.
- **3.1: only the latest one.** In 5 of 5 trials, A’s first send and the edited request never _both_ reused `[u1]`. When A reused it (3 trials), the edited request then found nothing. When A missed it (2 trials), the edited request reused it. Once a longer request has reused 3.1’s entry, the shorter one is gone. These data can’t tell “replaced by the longer entry” from “used up by the hit”.

In practice: on argon, a client that branches back to an earlier turn keeps every request it sent that ended at or before the branch point. On 3.1, branching back is cheap only if nothing has grown past the branch point. Claim tests: `src/claims/boundary.test.ts`.

### What breaks argon’s cache

The cache-breaker matrix: a warm request with a system instruction (~1,500 tokens), two tool declarations, a four-message history and a final message, ~6,840 tokens in all, of which ~4,790 are cached. Each trial changes exactly one thing and sends the request once. Every request is also counted with `countTokens`, so a trial where argon’s hidden block switched on or off is listed separately rather than blamed on the change.

<!-- report:breakers -->

- **Anything before the cached part’s end breaks it:** the system instruction, the first history message, and every change to the tools (a description, adding, reordering or removing one). The tools sit before the conversation.
- **Edits after it don’t:** the late question (the message the cached part ends in), the last model turn, the final message, an image added to the final message.
- **Appending a turn keeps it, unless argon adds its hidden block.** Here it did in 3 of 4 trials, and each of those lost everything. The one clean trial kept the whole cache. This is the same effect as the `long_chain` step-2 misses: on argon, normal conversation growth can switch the block on.
- **Some settings are part of the key:** changing `thinkingLevel`, or omitting `thinkingConfig`, loses everything though the prompt’s token count doesn’t change. JSON mode (`responseMimeType: "application/json"`) loses it and adds 67 hidden prompt tokens. toolConfig `NONE` loses it because it removes the tool declarations from the prompt (5,504 tokens instead of 6,840).
- **Most settings aren’t:** temperature, topP, maxOutputTokens, stop sequences, seed, `includeThoughts`, safety settings, toolConfig `ANY`, omitting toolConfig, and the key order inside a tool’s JSON schema all kept the cache in every trial.

Claim tests: `src/claims/breakers.test.ts`.

### Thought signatures

On 3.x, a model turn that calls a function carries a `thoughtSignature`, which must be sent back. The probe sends a function call after 18,000 words of filler, then its response plus 5,000 more words (A), then extends the thread past it (C). A is a strict prefix of C.

<!-- report:sig -->

**On 3.1, extending past the signature usually lost the whole cache:** in 6 of the 7 trials where A had been cached on its own repeat, C’s first send reused nothing. The seventh kept 20,905 of A’s 21,322 tokens. The text-only control, with the same sizes and no function call, kept all of A in 5 of 8. So on 3.1 even a plain extension right after a repeat isn’t dependable, and the signature makes a loss much more likely. 3.1 was flaky in this probe in another way too: in 2 of 9 trials, A’s _identical_ repeat cached only 161 tokens.

The billing columns show what changes. While the function call is the latest model turn, `generateContent` bills its signature: A’s `promptTokenCount` exceeds `countTokens` by roughly a fifth of the signature’s bytes. Once the thread moves on, it stops. C bills exactly what `countTokens` says, _less_ than A, though C contains all of A. So C is not a byte-for-byte extension of A as the model sees it. One explanation fits most trials: the dropped signature makes C diverge from A about 18,000 tokens in, inside A’s stored span, and 3.1 reuses an entry only whole (see the edit results). The one partial hit doesn’t fit that, so treat it as a hypothesis. The real threads above didn’t run into this. Their signatures sat in the last ~100 tokens of each request, inside the tail that is never cached anyway. An agent loop whose tool results are large might.

`countTokens` never counts the signature on 3.1, with or without it in the request.

**On argon, signatures are a constant 124 bytes, billed at most a few tokens, and never dropped.** Extending past the function call reused all of A whenever argon didn’t add its hidden block. argon’s `countTokens` also rejects a function call whose signature was removed (“Function call is missing a thought_signature in functionCall parts”), which 3.1’s accepts. Claim tests: `src/claims/signature.test.ts`.

### Gemini 4 sometimes bills 697 hidden tokens

On some requests argon’s `promptTokenCount` is exactly 697 tokens higher than `countTokens` for the same request (701 with a short system instruction). On every other request the two agree exactly.

<!-- report:inflation -->

- **It is a property of the request’s content.** Identical resends always get the same count: in 0 of 180 threshold trials did the prompt change between sends. Yet changing the last word of the final question flipped it in some trials.
- **It depends on the shape of the request.** In the inflation probe it never appeared on a single user message (0 of 72 sends), and it was more frequent with more, smaller messages: about a third of eight-message requests, fewer with two. A system instruction doesn’t prevent it. The signature probe, whose opening message asks for a tool call, also showed a smaller variant of about 414–420 tokens on two single-message requests, so the 697-token block isn’t the only form.
- **3.1 never does it** (0 of 24 sends in the cells where argon does it most).
- **It costs the whole cache when it appears.** When one request of a thread gains the block and the previous one didn’t, nothing is reused (`long_chain` step 2, 4 of 4 trials). Every argon miss in the signature probe came with it too. Requests that both carry it reuse each other normally.

What the block is, we can’t say from outside. It is billed as input, invisible to `countTokens`, and it breaks prefix reuse, so it sits somewhere before the end of the earlier request. Claim tests: `src/claims/inflation.test.ts`.

## Takeaways

- **For ordinary chat and agent loops, both models just work.** Append turns, never edit the past, and nearly every request reuses the previous one. Expect the last ~2,048 tokens of each request to be billed in full again on the next turn, unless more than that was appended since (the reply and your new message together).
- **argon caches much smaller prompts.** Anything over ~4,096 tokens qualifies, against ~9,000 for 3.1 to be dependable. Below 9,000 tokens, 3.1’s hits are luck.
- **Keep what changes at the end.** On both models, any change before the cached part’s end discards the whole cache, including the system instruction and tool declarations. Put anything that changes per request (timestamps, retrieved snippets, counters) in the latest message. On argon, avoid one giant message: with no message boundary before the change, even a late edit loses everything.
- **On argon, don’t switch `thinkingLevel` or JSON mode mid-conversation.** Both are part of the cache key. Sampling settings, output limits and safety settings are not.
- **On 3.1, mind big tool results after a function call.** Extending past a function call whose signature sits well inside the request (5,000 tokens from its end here) usually discarded the cache. Signatures within the last ~100 tokens, as in a tight tool loop, were harmless.
- **Don’t predict argon’s bill with `countTokens`.** It misses the 697-token block, and on 3.1 it misses the signature on the latest turn.

Every claim here is at the scope of this setup: synthetic text, these two model versions in October 2026, `thinkingLevel: "low"` except where a probe varies it, text-only requests apart from one tiny image, up to 128,000 tokens, and 2–9 trials per cell, shown as `n` beside each number.

## Verify it yourself

Every claim above has a test in `src/claims/` that runs the same procedure as the scripts and asserts what this page says. The recordings are committed, so the first command checks every claim offline. The second re-runs them all against the live API with fresh nonces (it needs `GEMINI_API_KEY` in `.env`).

```sh
pnpm --filter @experiments/gemini4_cache test              # replay every claim offline
RECORD=true pnpm --filter @experiments/gemini4_cache test  # re-run every claim live
```

To add trials to any table, re-run its script with `RUNS=N`, then `pnpm --filter @experiments/gemini4_cache report` to rebuild this page.
