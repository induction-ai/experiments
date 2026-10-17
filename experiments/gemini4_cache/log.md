# gemini4_cache log

Chronological notes: what was tried, what was found.

## 2026-10-15: Does gemini-4-argon’s implicit cache behave like gemini-3.1-pro-preview’s?

The Gemini API lists one Gemini 4 model, `gemini-4-argon`. This experiment
compares its implicit cache with `gemini-3.1-pro-preview`, measured side by
side, on four questions:

1. **Threshold.** What is the smallest request that caches? On 3.x the
   documented minimum was well below where hits actually began, and the
   onset seemed to depend on the history, not only the total size: a thread
   that grew turn by turn past the threshold cached, while the same tokens in
   one or two big messages sent cold might not. So the probe crosses total
   size with shape (`one`, `two_cold`, `two_grown`, `many_cold`,
   `many_grown`) to tell message count apart from growth.
2. **Reliability and granularity.** Above the threshold, how often does an
   identical repeat hit, and how is `cachedContentTokenCount` rounded?
3. **Signatures.** On 3.x, once a conversation is extended past a model
   function-call turn, that turn’s `thoughtSignature` seemed to cap the
   cached prefix at the signature’s position. Does it still?
4. **countTokens vs generateContent.** On 3.x the two disagreed once a
   signature left the tip of the conversation. Do they still?

Smoke tests (not in a CSV, before the harness existed):

- Both models answer with `thinkingConfig.thinkingLevel: "low"`.
  `gemini-4-argon` reports no `thoughtsTokenCount`; 3.1 does.
- "Say hi." with no system instruction bills 34 prompt tokens on argon and
  4 on 3.1, so argon may add about 30 hidden tokens. A ~12.4k-token request
  with a system instruction bills within 2 tokens on both, so it may be a
  default system prompt that a real one replaces. Not pursued yet.
- A ~12.4k-token prompt (5000 dictionary words in the system instruction)
  sent 3 times: both models cached on calls 2 and 3. argon 10,345 of
  12,394, and 3.1 10,352 of 12,396. Neither cached the whole prompt.
- A harness bug worth remembering: in zsh, `$m:generateContent` applies a
  `:g` modifier to `$m` and mangles the URL into a 404 with an empty body.
  Use `${m}`.

## 2026-10-15: Threshold pilot (`run-minimum.ts`, RUNS=1, shapes one + many_grown, 2000 and 6000 words)

8 trials, about 60k input tokens. Filler is about 1 token per word on both models.

| model | shape      | words | prompt | cached per send of final |
| ----- | ---------- | ----- | ------ | ------------------------ |
| argon | one        | 2000  | 2051   | 0;0;0                    |
| argon | one        | 6000  | 6052   | 0;4003;4003              |
| argon | many_grown | 2000  | 2133   | 0;0;0                    |
| argon | many_grown | 6000  | 6831   | 4537;4782;4782           |
| 3.1   | one        | 2000  | 2022   | 0;0;0                    |
| 3.1   | one        | 6000  | 6024   | 0;0;0                    |
| 3.1   | many_grown | 2000  | 2073   | 0;0;0                    |
| 3.1   | many_grown | 6000  | 6071   | 0;0;4042                 |

- argon caches a 6k single message, and 3.1 doesn’t. The first hint that
  argon’s onset is lower.
- 3.1’s grown 6k thread hit only on the third send of the final request, so
  "hit" on 3.1 may need more repeats than 3. Keep REPEATS=3 for now and
  watch for late hits.
- argon bills about 100 tokens per extra message (6831 for 8 messages vs
  6052 for 1 at the same filler); 3.1 bills about 6. Worth its own check
  later: it changes what "the same size" means across shapes.
- argon’s grown thread hit on the very first send of the final request
  (4537), because the warm-ups had stored the earlier turns.

## 2026-10-15: Signature probe pilot (`run-sig.ts`, RUNS=1, 18000 + 5000 words)

4 trials (one per model × variant). The argon `sig` trial was lost: argon’s
`countTokens` **rejects** A with m1’s signature stripped ("Function call is
missing a thought_signature in functionCall parts"), and the harness let
that error discard the row. Fixed: each countTokens call now fails on its
own and the message goes in a `ct_error` column, because the rejection is
itself a result. The columns changed, so the pilot rows were wiped
(FRESH=true). The three surviving rows:

| model | variant | pre_prompt | prompt_a | cached A1 / A2 | prompt_c | cached C1 / C2    | ct_a  | ct_c  | ct_a_nosig |
| ----- | ------- | ---------- | -------- | -------------- | -------- | ----------------- | ----- | ----- | ---------- |
| 3.1   | sig     | 18089      | 23630    | 18108 / 21591  | 23159    | **161** / 21120   | 23127 | 23159 | 23127      |
| 3.1   | text    | 18033      | 23060    | 16098 / 21013  | 23100    | **0** / 21114     | 23060 | 23100 | 23060      |
| argon | text    | 18067      | 23102    | 18068 / 21053  | 23146    | **21053** / 21097 | 23102 | 23142 | 23102      |

Surprises, all n=1:

- **3.1 bills the signature only while it is the latest model turn.**
  generateContent billed A at 23630, but countTokens at 23127 with or without
  the signature: about 500 tokens of signature counted by generate and never
  by countTokens. After the extension, C (a strict superset of A) billed
  _fewer_ tokens than A (23159), and exactly matched countTokens.
- **3.1 reused nothing when the thread was extended, even in the text
  control** (C1 cached 161 and 0), although A had cached about 21k on its
  own repeat and C2 cached about 21k. That is a stronger break than "capped
  at the signature’s position", and the text control has no signature.
  Either 3.1 doesn’t reuse an earlier request’s entry when the thread grows,
  or this was routing luck. More runs needed before saying anything.
- **argon’s text control reused all of A** on C’s first send (21053 =
  A2’s cached count), as a plain prefix cache should.
- 3.1 sig A1 cached 18108, _more_ than call 0’s whole prompt (18089). Call 0
  used toolConfig ANY and A uses AUTO, so the extra ~19 tokens may be the
  stored function call output. Recording `cached_0` from now on.

Re-ran argon `sig` after the fix (FRESH=true, so this is the first row of
the new `results/sig.csv`): signature 124 bytes (3.1’s was 2324), A2 cached
21127, and **C1 cached 21127**, all of A, so on argon extending past the
function call didn’t cap the cache. Two side notes, n=1:

- argon bills about 480 tokens for the one-tool declaration (pre_prompt 18547 with
  tools vs 18067 for the text variant without); 3.1 bills about 56.
- argon A1 cached 0 after call 0, although call 0 is A’s first message.
  Call 0 used toolConfig ANY and A used AUTO. On 3.1 the same switch
  still cached 18108. Possibly a toolConfig change breaks argon’s cache.
  Worth a direct check.

## 2026-10-15: Repeats pilot (`run-repeats.ts`, RUNS=1, 8000 and 32000 words, 6 sends)

| model | words | prompt | cached on sends 1–6 |
| ----- | ----- | ------ | ------------------- |
| argon | 8000  | 8052   | 0, 6003 ×5          |
| argon | 32000 | 32052  | 0, 30003 ×5         |
| 3.1   | 8000  | 8021   | 0 ×6                |
| 3.1   | 32000 | 32021  | 0, 29973 ×5         |

- **argon caches exactly prompt − 2049** every time: 8052→6003, 32052→30003,
  and the earlier 6052→4003 and 12394→10345 (dictionary words) fit too.
  So the cached count isn’t a block lattice: the cache keeps everything but
  a fixed ~2k tail.
- 3.1 holds back a similar tail (32021→29973, a 2048 gap; 12396→10352, 2044;
  6071→4042, 2029), slightly less regular.
- **3.1 never cached a single 8k message in 6 sends**; argon cached it from
  send 2. Consistent with 3.1’s onset sitting above 8k for this shape.
- Once a hit happens, every later send hit, on both models (n=1 per cell).

## 2026-10-15: Signature probe, 4 more runs (`run-sig.ts`, RUNS=4)

`results/sig.csv` now has 5 argon-sig and 4 of each other cell.

| model | variant | n   | C1 cached ≈ A2 cached (all of A) | C1 ≈ 0               |
| ----- | ------- | --- | -------------------------------- | -------------------- |
| argon | sig     | 5   | 4                                | 1                    |
| argon | text    | 4   | 4                                | 0                    |
| 3.1   | sig     | 4   | 0                                | 4 (161, 0, 161, 161) |
| 3.1   | text    | 4   | 2                                | 2                    |

- **3.1, sig:** extending past the function-call turn lost the whole cache
  every time, not just the part after the signature (which would have kept
  about 16–18k). The 161-token hits look like the tools + "Reference "
  header that every concurrent sig trial shares, not any of this trial’s
  own entry.
- **3.1, text:** only 2 of 4 extensions reused A. So on 3.1 even a plain
  text thread doesn’t reliably reuse the previous request when it grows.
  The signature result has to be read against that: is it "the signature
  breaks it" or "3.1 extensions are a coin flip, and it came up tails 4
  times"? n is too small to tell. More runs, plus a dedicated extension
  probe (below).
- **argon:** 8 of 9 extensions reused all of A. The miss (C1 = 0) is the
  one trial whose C billed about 1100 more tokens (24313 vs ~23225), so its
  model reply m2 was probably different, e.g. a second function call. Not
  recorded, so I can’t tell. Adding `m2_kind` and `m2_sig_bytes` columns.
- **Retracted:** the earlier "argon tools cost ~480 tokens" and "ANY→AUTO
  breaks argon’s cache" both came from the first argon-sig trial alone.
  The other four have pre_prompt 18125–18129 (vs 18063–18066 without
  tools, so about 62 tokens of tools, like 3.1’s 56) and A1 cached about 18.1k
  after the ANY call. That first trial is an outlier (pre_prompt 18547).
  Adding `model_version` from the response to see whether a different
  backend served it.
- **Signature billing on 3.1, n=4:** sig sizes varied widely (500–4044
  bytes), and prompt_a − ct_a tracked them (78, 391, 719, 987 tokens ≈ a
  fifth of the bytes). On every trial prompt_c = ct_c exactly, so once
  the signature is no longer in the latest model turn, generateContent stops billing
  it and agrees with countTokens. countTokens never counts it (ct_a =
  ct_a_nosig).
- **argon:** signature always 124 bytes, prompt_a − ct_a = 8 every time,
  prompt_c − ct_c = 14–20. countTokens rejects a stripped signature.

## 2026-10-15: Extension chains (`run-extend.ts`, RUNS=1, 20000 words, 6 steps)

Every request sent exactly once, appending the model’s real reply plus a
short user message (text) or a functionResponse (tool loop, ANY, so every
step is a signed function call).

**Every step from 1 on hit, on both models, in both chains** (20 of 20).
Each step cached the previous step’s prompt minus about 2048 (3.1: 2047–2054;
argon: 2049). So in a real append-only thread, signatures included, both
models reuse the previous request’s entry every time.

That contradicts the signature probe’s 3.1 misses. The difference: here
3.1’s function-call signatures are small (156 bytes, forced calls with little
thinking) and each sits in the last ~100 tokens of its request, inside the
~2048-token tail that is never cached anyway. In the signature probe m1’s
signature (500–4044 bytes) sits about 5000 tokens before the end of A. If 3.1
drops non-latest signatures from its tokenization (the prompt_c < prompt_a
result says it does), C diverges from A at about 18k. A cache that reuses any
matching prefix would still give C about 16–18k. It gave 0. Hypothesis: each
request stores **one entry** of about its first prompt − 2048 tokens, reused
only when a later request contains that entire span.

## 2026-10-15: Edit position (`run-edit.ts`, RUNS=2, 20000 words)

A warm single message, then one-word edits at 10%, 50%, 90% and 98% of the
way in, each sent once (ascending, so no sibling helps a later one).

| model | base sends | edit 0.1 | 0.5 | 0.9   | 0.98  |
| ----- | ---------- | -------- | --- | ----- | ----- |
| 3.1   | 0, 17977   | 0        | 22  | 17977 | 17977 |
| 3.1   | 0, 17979   | 0        | 22  | 17979 | 17979 |
| argon | 0, 18002   | 0        | 0   | 0     | 0     |
| argon | 0, 18001   | 0        | 0   | 0     | 0     |

- **3.1: all or nothing per entry.** An edit inside the entry’s span
  (10%, 50%) loses everything (22 tokens is some tiny entry other requests share).
  An edit past it (90% ≈ token 18,000 of 20,024, and 98%) keeps the whole
  entry. No partial reuse up to the edit, which supports the one-entry
  hypothesis.
- **argon: any edit loses everything, even at 98%,** where the first 18k
  tokens, the whole span argon reports as cached, are byte-identical.
  Yet argon reused every step of the append-only chains. So argon seems
  to reuse an entry only when the new request contains the _entire_ previous
  request as a prefix, and then credits prompt − 2049.
- Next: does argon look up entries at message boundaries, so that an edit in
  the last message can still reuse an earlier request that ended at a
  previous message? (`run-boundary.ts`)

## 2026-10-15: Boundary probe (`run-boundary.ts`, RUNS=2, 14000 + 8000 words)

| model | variant  | [u1] prompt | A1 cached    | A2 cached / prompt | edited cached    |
| ----- | -------- | ----------- | ------------ | ------------------ | ---------------- |
| argon | cold     | –           | 0, 0         | ~20025 / ~22074    | 22, 22           |
| argon | after_u1 | 14045–14047 | 14046, 14048 | ~20026             | **14046, 14048** |
| argon | edit_u1  | 14045       | 14046, 14047 | ~20025             | 0, 0             |
| 3.1   | cold     | –           | 0, 0         | ~19990 / ~22037    | 22, 22           |
| 3.1   | after_u1 | 14013–14016 | 14022, **0** | ~19990             | **22**, 14019    |
| 3.1   | edit_u1  | 14013–14016 | 14019, 14022 | ~19989             | 0, 0             |

- **argon** reuses the `[u1]` request whole (the u1 prompt + 1), both for A1
  and for the request with u2 edited, even after A extended it. With no
  earlier `[u1]` request (cold), the edit gets 22. So argon finds entries of
  _whole earlier requests_ that the new request begins with, and keeps old
  entries after a longer request extends them.
- **3.1** found the `[u1]` entry for only one of A1 and the edited request
  in each `after_u1` trial: run 1 A1 hit then the edit missed, run 2 A1 missed
  then the edit hit. That fits "when a request extends an entry, the
  entry is replaced by the longer one": in run 1, A replaced `[u1]`’s
  entry, and the edit, which breaks A’s span, found nothing. It would also
  explain the signature probe on 3.1 (A replaced call 0’s entry, then C broke A’s
  span at the stripped signature → 0). n=2, needs more runs.
- **The held-back tail is not always 2049.** Here argon credited the whole
  `[u1]` prompt (+1), not prompt − 2049. That `[u1]` request has no question,
  so the model’s reply was probably long. Hypothesis: the entry stores the
  generated tokens too, and the ~2048 tail comes off prompt + output, so a
  long enough reply covers it. That also fits 3.1’s sig probe A1 caching
  18108 against call 0’s 18089-token prompt (the stored function call
  matched m1). Test: repeats with a long-answer ask.

## 2026-10-15: Threshold sweep (`run-minimum.ts`, RUNS=2, 1000–16000 words, all shapes), crashed

A network timeout (`fetch failed`, `UND_ERR_HEADERS_TIMEOUT`) killed the run
after 148 of 200 trials; every trial up to then had appended its row.
Fixed: `post` now retries thrown fetch errors like a 503.

Hits / trials (median prompt tokens in brackets for the edge cells):

| words | argon one  | two_cold | two_grown | many_cold  | many_grown | 3.1 one     | two_cold | two_grown | many_cold  | many_grown |
| ----- | ---------- | -------- | --------- | ---------- | ---------- | ----------- | -------- | --------- | ---------- | ---------- |
| 3000  | 0/2        | 0/2      | 0/2       | 0/2        | 0/2        | 0/1         | 0/1      | 0/1       | 0/1        | 0/1        |
| 4000  | 0/2 (4051) | 0/2      | 0/2       | 2/2 (4133) | 2/2        | 0/1         | 0/1      | 0/1       | 0/1        | 0/1        |
| 5000  | 2/2        | 2/2      | 2/2       | 2/2        | 2/2        | 0/1         | 0/1      | 0/1       | 0/1        | 0/1        |
| 6000  | 3/3        | 2/2      | 2/2       | 2/2        | 3/3        | 0/2         | 0/1      | 0/1       | 0/1        | 1/2        |
| 8000  | 2/2        | 2/2      | 2/2       | 2/2        | 1/1        | 0/1 (8018)  | 0/1      | 0/1       | 1/1 (8075) | 0/1        |
| 10000 | 2/2        | 2/2      | 2/2       | 2/2        | 1/1        | 1/1 (10024) | 1/1      | 1/1       | 1/1        | 1/1        |

(1000–2000 missed everywhere, 12000–16000 hit everywhere.)

- **argon: a plain size threshold at about 4096 prompt tokens, any shape.**
  4051 misses and 4133 hits, and `many_*` at 4000 words hits only because
  8 messages add about 80 tokens of overhead. Fine sweep next: 3800–4300 words.
- **3.1: onset between about 8k and 10k, noisier.** Single messages missed at
  8018 and hit at 10024, many_cold hit at 8075, many_grown hit 1/2 at 6071
  (the pilot, on its third send). n=1 per cell: not enough to say whether
  history shape moves the onset. Fine sweep next: 6000–10000 words, RUNS=3,
  REPEATS=4.
- **argon sometimes bills about 700 extra prompt tokens**: two_cold 2000 words →
  2766 (vs ~2067), two_cold 5000 → 5764, many_grown 6000 → 6831,
  many_cold 10000 → 10830, many_cold 12000 → 12830. The sig probe’s 18547
  outlier looks like the same thing (+420). Not tied to shape. Adding
  `model_version` and every send’s prompt to the CSVs to see whether a
  different backend serves those requests. The columns change, so
  `minimum.csv` starts fresh; the numbers above are this log’s record of it.

## 2026-10-15: Repeats with a long reply (`run-repeats.ts`, FRESH, RUNS=1, 8000 and 20000 words, 3 sends, ASKS short,long)

`repeats.csv` restarted with `ask`, `output`, `thoughts` and `model_version`
columns (the 4 pilot trials above are in this log only).

| model | words | ask   | output tokens                   | cached on sends 1–3 / prompt |
| ----- | ----- | ----- | ------------------------------- | ---------------------------- |
| argon | 20000 | short | 5                               | 0, 18003, 18003 / 20052      |
| argon | 20000 | long  | 5094–6756                       | 0, 18021, 18021 / 20070      |
| argon | 8000  | long  | 4859–8192                       | 0, 0, 6020 / 8069            |
| 3.1   | 20000 | short | 1–2                             | 0, 17977, 17977 / 20024      |
| 3.1   | 20000 | long  | 1087–1947 (+1000–1300 thinking) | 0, 17991, 17991 / 20038      |
| 3.1   | 8000  | both  |                                 | 0, 0, 0                      |

- **Refuted:** a long reply does not let the identical repeat cache the whole
  prompt; argon still holds back 2049 and 3.1 2047. So the tail isn’t simply
  "prompt + output − 2048" read back on a repeat.
- argon 8000 long hit only on send 3: the first late hit seen on argon.
- Two explanations for the boundary probe’s full-`[u1]` credit remain:
  - B: the tail comes off the _new_ request, `cached = min(whole earlier
request, new prompt − 2049)`.
  - C: an entry covers prompt + output − ~2049, and a repeat can’t use the
    part past its own prompt.

  The chains (short replies) give prev − 2049, which fits C (and fits B only
  within 28 tokens). Decisive: a chain whose first reply is long. B
  predicts step 1 ≈ P0; C predicts ≈ P0 + O0 − 2049.

## 2026-10-15: Long-reply chain (`run-extend.ts`, FRESH, RUNS=1, CHAINS=long_chain, 3 steps)

`extend.csv` restarted with an `output` column (the 4 chain trials above are
in this log only).

| model | step | prompt | cached    | output           |
| ----- | ---- | ------ | --------- | ---------------- |
| argon | 0    | 20069  | 0         | 4924             |
| argon | 1    | 25016  | **20070** | 5                |
| argon | 2    | 25741  | **0**     | 5                |
| 3.1   | 0    | 20038  | 0         | 1477 (+thinking) |
| 3.1   | 1    | 21530  | 17986     | 2                |
| 3.1   | 2    | 21547  | 19476     | 2                |

- **argon step 1 cached step 0’s whole prompt + 1** (20070), not P0 − 2049
  (as a short reply gives) and not P0 + O0 − 2049. The rule that fits every
  argon result so far: `cached = min(P_old + 1, P_old + O_old − ~2049,
P_new − 2049)`. In words: an entry reaches at most one token past the old
  prompt; with a short reply it falls ~2049 short of that; and the new
  request always recomputes its own last ~2049. To confirm with more
  trials.
- 3.1 step 1 cached 17986 ≈ P0 − 2052: its long reply didn’t help at all.
  So 3.1 doesn’t follow argon’s rule.
- **argon step 2 grew by 725 tokens though only ~28 were appended, and
  cached 0.** That is the ~700-token anomaly in the middle of a real chain,
  and it cost the whole cache.

Re-reading `minimum.csv` (old columns) for the anomaly: **20 of 95 argon
trials** had an inflated final prompt: +~765 tokens over the expected size for
`two_*`, +~830 for `many_*`, and **never for `one`** (0 of 19). It
held on every send of the final request (their later sends hit at prompt −
2049 of the inflated size), and within grown threads it switched on and off
between turns (e.g. warm-ups 795, **3014**, **4536**, 5361, then final
**6829**). So argon sometimes adds roughly 700–830 hidden tokens to a
request that contains a model turn. Where they go in the prompt decides
whether they break reuse; the step-2 miss suggests before the earlier content.

## 2026-10-15: Signature (FRESH, RUNS=5), boundary (+3 runs) and edit (+2 runs) repeats

`sig.csv` restarted with `m2_kind`, `m2_sig_bytes` and `model_versions`
(the 9 earlier sig trials are recorded in this log above). Every
`modelVersion` was the requested model name, so the field can’t tell
backends apart.

**Signature probe, n=5 per cell** (C1 = first send of the extended thread):

| model | variant | C1 kept A  | C1 lost                 | notes                                                             |
| ----- | ------- | ---------- | ----------------------- | ----------------------------------------------------------------- |
| 3.1   | sig     | 0          | 5 (0, 161, 0, 161, 161) | signatures 364–4456 bytes                                         |
| 3.1   | text    | 4 (≈21007) | 1 (22)                  | the miss is a trial where A2 also cached 0                        |
| argon | sig     | 3 (≈21125) | 2                       | both misses: C inflated (23643, 23642 vs ~23225)                  |
| argon | text    | 4 (≈21052) | 1                       | the miss: call 0 inflated (18479), A1 and A2 cached 0, C inflated |

Pooled with the first 9 trials: **3.1 sig lost the whole cache 9 of 9
times; 3.1 text kept it 6 of 9.** Even a 364-byte signature did it. So on
3.1, extending past a function call whose signature lies inside the previous
request’s stored span (here ~5000 tokens from its end) loses everything,
not "everything after the signature". The mechanism fits what the other
probes show: generateContent drops the non-latest signature (prompt_c = ct_c
every time, below prompt_a), C diverges from A’s entry inside its span, and
3.1 reuses an entry only whole. The chains kept hitting because their
signatures sat in the last ~100 tokens, outside the span.

**argon’s misses all came with inflation**: 4 of 4 argon misses in this
batch had an inflated request (+~420 on a single-message call 0, +~420–750 on
C). Inflation also hit single-message requests here (call 0: 18479 and 18828
vs ~18066 and ~18126), so "never for `one`" from the sweep was too strong.
One unexplained argon trial: call 0 inflated, then A (not inflated) cached 0
on _both_ sends.

**Boundary, n=5 per cell:**

- argon: cold → 22 (5/5); after_u1 → the edit reuses u1 + 1 (5/5); edit_u1 → 0 (5/5).
- 3.1: cold → 22 (5/5); edit_u1 → 0 (5/5); after_u1: **A1 hit [u1] and then
  the edit missed (3/5), or A1 missed and then the edit hit (2/5), never
  both**. So once a longer request has reused 3.1’s entry, the shorter one is
  gone ("replaced on extension" or "used up by a hit", which these data can’t
  tell apart). argon keeps it (5/5).

**Edit, n=4 per model:** same pattern in every trial. argon: every
edit → 0. 3.1: 10% → 0, 50% → 22, 90% and 98% → the whole entry.

## 2026-10-15: Fine threshold sweeps (`run-minimum.ts`, FRESH, RUNS=3, all shapes)

argon at 3800–5000 words (REPEATS=3), 3.1 at 6000–12000 words (REPEATS=4);
180 trials, no errors. `minimum.csv` now has `prompts_all` and
`model_versions`. **In 0 of 180 trials did the prompt change between
identical sends**, inflated ones included.

- **argon: a sharp onset near 4096 prompt tokens, the same for every
  shape.** Largest prompt that missed / smallest that hit: one 4053 / 4150,
  two_cold 4070 / 4167, two_grown 4071 / 4166, many_cold 4038 / 4135,
  many_grown 4037 / 4135. Pooled: every request ≤ 4071 tokens missed and
  every request ≥ 4135 hit. The cells that hit below 4000 words were all
  inflated past 4096 (e.g. two_grown 3800 words → 4564 tokens). A hit at
  4135 caches 2086 = 4135 − 2049, so the rule "prompt − 2049 must reach
  2048" puts the onset at 4097. Consistent, though the data only bracket it.
- **3.1: fuzzy, then reliable from about 9000 tokens.** At 9000 words
  (9023–9074 tokens) all 15 trials hit, across all shapes, from send 2. At
  6000–8000 words, 5 of 45 trials hit, and often on one send only (e.g.
  many_cold 6069: 0, 4248, 0, 0; one 8024: 0, 0, 5982, 0). At 7000 words: 0 of 15.
- **History shape didn’t move the onset on either model.** At 3.1’s edge
  (8000 words) the five shapes hit 1, 0, 0, 1, 1 of 3; argon’s edge is the same
  for all five in tokens. `*_grown` threads didn’t cross sooner than cold ones:
  their earlier turns were themselves below the threshold, so they stored
  nothing to reuse. The history effects this experiment does find are about
  _which entries earlier requests left_ (boundary, edit and signature
  probes), not about where caching starts. Stated at this scope: synthetic
  filler, these two models, 3 trials per cell.

## 2026-10-15: Chains (`run-extend.ts`, RUNS=3, all three chains)

Pooled with the first long_chain trial:

| model | chain      | steps that hit                                     | held back (prev prompt − cached) |
| ----- | ---------- | -------------------------------------------------- | -------------------------------- |
| argon | text_chain | 15 / 15                                            | 2049 every time                  |
| argon | tool_chain | 15 / 15                                            | 2049 every time                  |
| argon | long_chain | step 1: 4 / 4, step 2: **0 / 4**, steps 3–5: 7 / 7 | step 1: −1 (whole prompt + 1)    |
| 3.1   | text_chain | 15 / 15                                            | 2051–2054                        |
| 3.1   | tool_chain | 14 / 15                                            | 2043–2047                        |
| 3.1   | long_chain | 16 / 16                                            | 2051–2054                        |

- argon long_chain step 2 was **inflated by exactly +725 and missed in all 4
  trials**, though the stories differed. So inflation follows structure,
  not only chance content. Steps 3–5 then hit with the usual 2049 gap,
  reusing the inflated step 2: inflated requests reuse each other normally.
  (One trial’s step 5 deflated (−669) and still hit, with a 2746 gap,
  presumably from an older uninflated entry.)
- The one 3.1 tool_chain miss was at step 1.

## 2026-10-15: Inflation (`run-inflation.ts`, RUNS=9 on argon, RUNS=6 control on 3.1)

108 argon trials (216 sends), each a request and a copy whose final question
differs by one word ("OK" vs "YES"):

| shape     | words | sends inflated (no system / short system) |
| --------- | ----- | ----------------------------------------- |
| one       | 4000  | 0/18, 0/18                                |
| one       | 16000 | 0/18, 0/18                                |
| two_cold  | 4000  | 3/18, 2/18                                |
| two_cold  | 16000 | 0/18, 0/18                                |
| many_cold | 4000  | 6/18, 8/18                                |
| many_cold | 16000 | 4/18, 4/18                                |

- **A fixed block: exactly 697 tokens with no system instruction, 701
  with a short one.** Every other request had prompt − countTokens = 0.
- **Never on a single user message** (0/72 here, and none of the single-message
  requests in either threshold sweep). It is more frequent with more and smaller
  messages. A system instruction doesn’t prevent it.
- **A one-word change to the final message toggled it in 13 of 108
  trials**, while identical resends never change it. So it is a deterministic
  function of the request’s content.
- The signature probe showed ~420- and ~700-token variants on requests with
  tools, including single-message ones. So tools are a separate trigger.
- 3.1 control: 0 of 24 sends in the cells that inflate argon most.
- Effect on caching, from the other probes: when consecutive requests of a
  thread differ in inflation, the later one misses completely (long_chain
  step 2, 4/4; signature probe, every argon miss). The block sits somewhere
  inside the span that would have matched, which for argon means anywhere
  before the end of the earlier request.

## 2026-10-15: Repeats at more sizes (`run-repeats.ts`, RUNS=2, ASKS=short, 4200–64000 words, 3 sends)

- argon held back exactly 2049 on every hit, at 4251, 4254, 16053, 16054,
  32051, 32054, 64051 and 64052 prompt tokens.
- 3.1 held back 2046–2049 (16023 → 13977, 32024 → 29976, 64023 → 61974),
  and never cached 4222/4223 (below its threshold).

## 2026-10-15: Signature probe, 4 more runs (RUNS=4; `sig.csv` now n=9 per cell)

- 3.1 sig: C1 reused nothing in 6 of the 7 trials where A2 was cached, but
  **one trial kept 20905 of A2’s 21322** (signature 1180 bytes). That doesn’t fit
  "C diverges from A at the dropped signature ~18k in", so the mechanism is
  a hypothesis, not established. The blog says so.
- 3.1 sig: in 2 of 9 trials **A’s identical repeat cached only 161**, after
  A1 had reused call 0’s entry (A1 21769 and 18105). 3.1’s repeats probe
  never did that.
- 3.1 text control: kept A in 5 of 8 warm trials.
- argon: C kept A in 6 of 9; all 3 losses had C inflated (+~420). The text
  control kept A in 8 of 8 warm trials.
- 3.1’s claim test "extending past … reuses nothing" can fail on a live
  re-run about 1 time in 7 (the partial hit). Kept as is, since it asserts
  the usual outcome on one trial. The blog gives the 6-of-7 count.

## 2026-10-15: First live recording of the claim tests (`RECORD=true`), and the long-reply step

40 of 41 claim tests passed live. The failure: "3.1: a long reply doesn’t
change what the next request reuses". In the recording, 3.1’s step-0 reply was
2255 tokens and step 1 then cached P0 − 4, i.e. nearly the whole previous
prompt, as argon does. Every earlier 3.1 long_chain reply was 1134–1535
tokens, with gap ~2052. So the rule is a step on both models: a reply
longer than ~2049 tokens lets the next request reuse the whole previous
prompt; a shorter one doesn’t help at all (no partial benefit: 1520 tokens
still gave 2052). The `min(P_old + 1, P_old + O_old − 2049, …)` rule in the
earlier entry is wrong for O < 2049 and is dropped.

Probing the step:

- `mid_chain` (~700-word story, RUNS=3): replies 417–1070 tokens; step 1
  held back 2049 (argon) and 2052–2053 (3.1). No benefit.
- `xl_chain` (~6000-word story, RUNS=3): argon replied 3576–7352 tokens →
  P0 + 1 (3/3); **3.1 still replied only 385–1785** → gap ~2050.
- `copy_chain` (copy 3000 words verbatim, RUNS=3): **3.1 mostly declined**
  (323-token replies) and step 1 missed in 2 of 3. **argon inflated two of
  three single-message step-0 requests** (+694, +1107), then missed step 1.
  A copy-verbatim ask triggers argon’s hidden block even on one message.
  That fits a hidden instruction added by some content check, but it’s
  only a guess.
- `para_chain` (40 numbered paragraphs): a quick direct check gave 3.1
  replies of 3663 and 3614 tokens. But the first `para_chain` run was
  capped at 1024 output tokens by a harness bug: the variant list that picks
  maxOutputTokens 8192 had been reformatted by prettier, so my scripted edit
  never added `para_chain` to it. Its rows are invalid. Also seen in those
  capped rows: argon missed step 1 in 3 of 3 with a 1024-token
  (MAX_TOKENS) reply, prompt not inflated. Unexplained; a truncated reply
  may leave no entry.

Cleanup: the chain list is now one `LONG_ASKS` table (no hand-kept
variant list). `xl_chain` and `copy_chain` are dropped as dead ends
(recorded here), and `extend.csv` restarts FRESH so every row matches a
variant that exists in the code.

## 2026-10-15: Chains regenerated (`run-extend.ts`, FRESH; RUNS=3; text/tool/long 6 steps, mid/para 2 steps)

- text_chain / tool_chain: argon 30 of 30 steps hit (gap 2049); 3.1 29 of 30
  (one text_chain miss at step 2; gaps 2043–2077).
- long_chain: argon step 1 → whole prompt + 1 (3/3), **step 2 inflated and
  missed again (3/3)**; 3.1 replies stayed under 2049, gap 2051–2054.
- mid_chain (replies 368–1047): gap 2049 (argon) / 2053–2054 (3.1), 6/6.
- **para_chain (replies 3350–3919): the next request reused the whole
  previous prompt on both models**: 3.1 gap 2–3 (3/3), argon −1 (2/3). The
  step rule holds on 3.1 too.
- The argon para_chain miss: a 7507-token reply, but step 1’s prompt grew by
  only 4649 (expected ~7530), and cached 0. Output tokens that aren’t all
  sent back (hidden thinking counted as output?) and a miss. Unexplained.

## 2026-10-15: Claim tests recorded, report published locally

- Claim tests: `src/claims/` (7 files, 43 claim tests + 11 harness tests).
  First live pass: 40/41 (the 3.1 long-reply failure, which led to the step
  rule). After rewriting the chain and 3.1-signature claims, re-recorded
  those two files. One more live failure along the way: a 3.1 text_chain
  step cached 0, the same rare miss as in the CSV (1 in 30). The test now
  allows 3.1 at most one miss in three steps, as the blog states. Latest
  live recordings of every file passed.
- Replay needed an API key because the client asked for one before Polly
  could intercept. A missing key turned attempt 0 into an error, and the
  precondition helper then looked for an attempt that was never recorded.
  Fixed: replays use a placeholder key. `pnpm test` now passes 54/54 with
  `GEMINI_API_KEY` empty.
- Recordings checked for identifiers: only generic Google headers
  (`server-timing`, `x-gemini-service-tier`, …), API key masked.
- `pnpm lint` is not clean repo-wide, but every error and warning is in
  `cache_breakers` (pre-existing); this workspace is clean.
- 3.1’s held-back range in threads widened to 2043–2077 with the regenerated
  chains (one step at 2077); blog updated.

## 2026-10-15: Is the 2049 tail generic? (`run-tail.ts`, RUNS=2)

The user challenged "all but the last 2,049 tokens, exactly" as too general.
Two answers:

1. Over every hit in every CSV, argon’s `prompt − cached` was **never below
   2049** (0 exceptions in 293 hits), and exactly 2049 only when the stored
   entry reached that far (identical resends, edits after the span, whole
   earlier requests). In threads it is larger (2049 + what was appended), and
   after a reply longer than 2049 the previous prompt is reused whole. So
   the general statement is "a hit never covers the last 2049 tokens of the
   request being sent", not "a hit covers all but 2049". 3.1 isn’t even a
   floor: gaps as small as 1821 and 1986 appear in its threshold and sig hits.
2. A one-factor-at-a-time probe on identical repeats (baseline: filler words
   in one user message, thinkingLevel low, ~8000 tokens). **argon: tail 2049
   in all 14 trials**, with random alphanumeric content (8799, 8923 tokens),
   JSON records (9379, 9403), thinkingLevel high, no thinkingConfig, content
   in the system instruction, and 128k tokens (128053 → 126004). 3.1: 2043–2050
   wherever it cached. Its 8k variants were below its ~9k threshold (my
   setup mistake), so they were rerun at 12k.

## 2026-10-15: Cache breakers on argon (`run-breakers.ts`, pilot RUNS=1, 27 variants)

The user asked for the cache_breakers matrix on argon. Base: system
instruction (1500 words), 2 tools (600-word descriptions), 4 history messages
(900 words each), final message (300 words), ~6840 tokens, cached span
~4790. Pilot, one trial each:

- **Kept everything:** control, `late_edit_end` (edit the last model turn),
  `final_edit`, `image_in_final`, `system_as_two_parts`,
  `tool_schema_key_order`, `prev_turn_then_final_edit`, temperature, topP,
  maxOutputTokens, stopSequences, seed, includeThoughts, safetySettings,
  toolConfig ANY, toolConfig omitted.
- **Lost everything:** `system_edit_end`, `early_edit_end`, every tools
  change (description edit, add, reorder, remove all), **thinkingLevel high,
  thinkingConfig omitted** (prompt unchanged, so the level is part of the
  key), toolConfig NONE (which drops the tool declarations from the prompt:
  5504 vs 6840).
- `append_turn` lost everything but its prompt gained argon’s hidden block
  (+701). Confounded; needs more trials. `json_mime_type` also removed the
  tools, so it was confounded with `tools_remove_all`; rewritten to compare
  against a warmed no-tools copy, with a `no_tools_control`.

**This corrects the edit finding.** Edits to `m_late` and `u_final` kept
the whole span, though the base isn’t a prefix of the edited request. The
cached span (~4790) ends inside `u_late`. Those edits touch only messages
entirely after it. The single-message 98% edit lost everything because it
changed the message the span ends in. New hypothesis: **argon reuses a
stored span only if every message it overlaps is unchanged (message-
granular), where 3.1 is token-granular.** Every earlier argon result fits.
Added the decisive variant `late_question_edit_end`: edit the message the
span ends in, after the span’s end. Per-message → lost; per-token → kept.

## 2026-10-15: Breakers on argon (`run-breakers.ts`, RUNS=3; `breakers.csv` now n=3–4 per change)

- **Kept the cache in every clean trial:** control, image in final,
  late-message edit, final edit, system split into two parts, tool schema
  key order, temperature, topP, maxOutputTokens, stopSequences, seed,
  includeThoughts, safetySettings, toolConfig ANY, append_turn (3/3 clean;
  the 4th switched on the hidden block), prev_turn_then_final_edit.
- **Lost it every time:** system edit, early edit, every tools change,
  thinkingLevel high, thinkingConfig omitted, JSON mode (4/4, and it adds 67
  hidden prompt tokens: 5568 billed vs 5501 counted), toolConfig NONE (drops
  the tool declarations from the prompt).
- toolConfig omitted: 3 of 4 kept, one unflagged miss.
- **`late_question_edit_end` kept the whole span (3/3)**, though the edit is in
  the message where the span ends (span 4789; that message runs ~4700–5608).
  That **refutes the per-message hypothesis** from the pilot.

## 2026-10-15: Edit probe with a split shape (`run-edit.ts`, FRESH, RUNS=3, shapes one + split)

Reconciling the two: the single-message 98% edit lost everything, while the
multi-message edit after the span kept it. New hypothesis: argon only _finds_
an entry through a message boundary that both requests share, and then
reuses it all or nothing. Decisive test: the same 20k-word text as one user
message, or split into user + model messages at 40%:

| model | shape | 10% | 50% | 90%         | 98%         |
| ----- | ----- | --- | --- | ----------- | ----------- |
| argon | one   | 0   | 0   | 0           | 0           |
| argon | split | 0   | 22  | 18011–18013 | 18012–18014 |
| 3.1   | one   | 0   | 22  | ~17975      | ~17975      |
| 3.1   | split | 0   | 22  | ~17977      | ~17977      |

All 3 trials per cell agree. **Confirmed:** with a message boundary before
the span’s end, argon keeps the span on a later edit, exactly as 3.1 does.
Without one, it can’t find the entry at all. The blog’s "argon reuses nothing
after any edit" and "only whole earlier requests" are replaced by this rule.
(One 3.1 trial: the base’s own repeat cached 0, yet the 90% edit then reused
the base’s first send. Another case of 3.1’s random misses.)

On the user’s question about blocks: across 77 distinct argon prompt sizes
(identical repeats), cached counts took 76 distinct values mod 2048 (61 mod 128) and moved one-for-one with the prompt (4150 → 2101, 4151 → 2102, 4152 →
2103). So the billed count is not aligned to blocks from the start; the
constant is the 2049 tokens before the end. Internal storage may still use
blocks (argon’s 4096 minimum is 2 × 2048); the billing doesn’t show it.

## 2026-10-15: Breakers regenerated (FRESH, RUNS=4) and claim tests recorded

`breakers.csv` was regenerated because the first JSON-mode trial came from the
pilot version of that variant (tools removed, no warmed no-tools copy). Every
outcome matched the first run, with two refinements:

- toolConfig omitted: kept 4/4 (the earlier miss was a one-off).
- **append_turn switched on argon’s hidden block in 3 of 4 trials** (each lost
  everything); the clean trial kept the whole cache. final_edit and
  prev_turn_then_final_edit each switched it once.

Edit, tail and breakers claim tests (40 tests) recorded live and passed.

## 2026-10-15: Real examples of the 2049 tail in the report

The user asked for drawn examples. `build-report.ts` now renders
`<!-- report:tailExamples -->`: six real argon requests as bars split into
cached / full price / new, picked from the CSVs at build time (an identical
resend at 8052; the largest miss 4071 and smallest hit 4135; 128053; one
text_chain step; one para_chain step after a 3394-token reply).

While picking them: argon’s 4096 minimum fits "2049 held back + at least
2048 cached". 4071 would have left 2022 and cached nothing; 4135 left 2086
and cached. The data bracket the minimum cached part between 2023 and 2086,
so the blog presents it as a likely explanation, not a finding.

Palette check (dataviz validator): cached #2a78d6 / #3987e5, full price
#898781 / #6b6a65. Every check passes in both modes except the chroma floor,
which is expected for a neutral “the rest” fill (not a categorical slot).

## 2026-10-15: Two conversations, same size (`run-two-turns.ts`), and a correction

The user asked for a blog section with two worked examples and their code
in its own file. The code is `src/two-turns.ts`; the report embeds it
verbatim. Both conversations open with a 10,000-token message: (A) a
one-word reply, then 3,000 tokens of your own text; (B) a ~3,400-token reply,
then a one-line follow-up.

**Correction.** I had told the user that in (A) turn 2 would cache only
turn 1 − 2,049 (7,951 of a 10k turn 1), because only a _long reply_ lets the
next request reuse the whole previous prompt. Wrong: in (A), turn 2 cached
all of turn 1 (+1 on argon, 3/3; within 1–3 on 3.1, 3/3), the same as (B).
The variable is **how much is appended** since the previous request (reply +
new message, whoever wrote them), not the reply length. Every earlier chain
had paired a long reply with a short follow-up, so the two were confounded.

Rule that fits every result: each request leaves two reusable points, its
prompt − 2,049 and its whole prompt (+1); the next request can’t use anything
inside its own last 2,049 tokens, so it gets the whole previous prompt only
if it appended more than ~2,049 tokens. There are no points in between, so
there is no partial benefit (which is why 400–1,800-token replies gave none).

Decisive sweep (your own text after a one-word reply, RUNS=2, both models):
appended 1,727–2,026 tokens → turn 1 − 2,049 (argon 8,007–8,009; 3.1
7,980–7,984); appended 2,127–2,428 → all of turn 1. The edge sits between
2,026 and 2,127 on both models, consistent with 2,049. Misses: one argon
trial gained the hidden block (+697); 3.1 missed twice at random.

A harness slip on the way: the first sweep never passed `appendWords` to
`twoTurns` (a scripted edit didn’t match prettier’s formatting), so every
size ran at 3,000 words. Those rows were mislabelled; `two_turns.csv` was
regenerated FRESH.

The blog’s tail section, at-a-glance row, real-examples figure and takeaway
now say "appended more than 2,049" instead of "a reply longer than 2,049";
the two chain claim tests were renamed to match.

## 2026-10-16: 4,100 tokens, then 1,000 or 2,100 more (`run-two-turns.ts`, OPENING_WORDS=4050)

The user’s test: what does turn 2 cost after a ~4,100-token turn 1 plus 1,000
tokens, given the naive expectation "4,100 cached, 1,000 full price"?
argon, clean trials:

- +1,000 words: turn 1 4,108–4,109 → turn 2 5,135–5,136, **cached 2,059–2,060
  (turn 1 − 2,049), full price 3,076** (5 of 5 clean; 2 more trials had the
  hidden block on turn 2 and cached 0).
- +2,100 words: turn 2 6,229–6,236, **cached turn 1 + 1, full price 2,126**
  (3 of 3).
- 3.1 cached nothing in either (both turns below its ~9k threshold).

So the user’s draft explanation ("we pay for 2,049 and 3,051 is cached") is
half right: the full-price part is _at least_ 2,049, but when less than 2,049
is appended it’s the previous request’s last 2,049 _plus_ everything new
(3,076 here), because the cache can only resume at points earlier requests
saved (prompt − 2,049, or the whole prompt). It can’t resume at the new
request’s end − 2,049. That matches every two_turns result and the "saved
points from the end" reading over blocks from the start (4,108 → 2,059, not
2,048 or 4,096).

Harness slips: (1) the CSV guard correctly refused to append when the new
`opening_words` column appeared, so `two_turns.csv` was regenerated; (2) the
runner then never _wrote_ `opening_words` (again a scripted edit that missed
after prettier), so all 52 regenerated rows had it blank, and the report
mixed the 4,100-token rows into the 10k edge table. The procedure itself ran
correctly; only the label was missing. Fixed the runner, added a check that
refuses to write a row without its condition columns, and regenerated FRESH.

## 2026-10-16: The exact case on OpenAI and Gemini (`run-exact-4100.ts`)

The user asked to prove the OpenAI side of their draft ("OpenAI caches the
4,100 and we pay full price for the 1,000") and to have one file with exactly
this case for both providers: `src/exact-4100.ts`. Each request is fitted to
an exact token count with the provider’s counting endpoint (OpenAI
`/v1/responses/input_tokens`, Gemini `countTokens`), then sent; billed sizes
matched the targets exactly.

| provider           | turn 1 | appended      | cached | full price    | trials     |
| ------------------ | ------ | ------------- | ------ | ------------- | ---------- |
| OpenAI gpt-5.6-sol | 4,100  | 1,000         | 4,097  | 1,003         | 9/9        |
| OpenAI gpt-5.6-sol | 4,100  | 2,100         | 4,097  | 2,103         | 9/9        |
| OpenAI gpt-5.6-sol | 4,000  | 1,000 / 2,100 | 3,997  | 1,003 / 2,103 | 9/9, 8/8   |
| Gemini 4 argon     | 4,100  | 1,000         | 2,051  | 3,049         | 5 clean    |
| Gemini 4 argon     | 4,100  | 2,100         | 4,101  | 2,099         | 3 clean    |
| Gemini 4 argon     | 4,000  | 1,000 / 2,100 | 0      | 5,000 / 6,100 | 3, 2 clean |

- OpenAI: the draft is right up to 3 tokens. It caches all but the last 3
  tokens of turn 1 (likely the assistant-turn marker), in every trial.
- Gemini: the draft’s numbers are exact (2,051 / 3,049; 4,101 / 2,099).
- 4,000 + 2,100 caching nothing **refuted my prediction** that a sub-minimum
  request’s end point would be usable after a large append. The minimum
  applies to the request.
- Gemini blocked 10–14 turn-2 requests (`promptFeedback.blockReason: OTHER`),
  never turn 1, and never in the two_turns probe. This file strips the reply’s
  thoughtSignature to keep counts exact, the likely trigger; an 8-trial
  scratch rerun had no blocks, so it isn’t deterministic.
- Harness slips, again from scripted edits missing after prettier: the first
  4,000-token run actually sent 4,100 (turn 1 fitted to the constant, and the
  runner didn’t pass `turn1`). Caught because the log printed turn 1 = 4,100
  for "4000" rows; regenerated FRESH, and the runner now checks the billed
  size against the target (OpenAI) and refuses rows without their conditions.
- Claim tests: `src/claims/exact-4100.test.ts`, 6 tests, recorded live and
  passing. OpenAI recordings checked: key, organization, project and cookies
  masked.

Also filled the TODO figures in the site post
`parallel/apps/site/app/(blog)/blog/caching-in-gemini-4-argon/` with these
measured numbers (data.ts cites this CSV).

## 2026-10-16: A third request on the exact chains (`run-exact-turn3.ts`)

The user asked what turn 3 caches, especially after the 1,000-token turn 2.
Each chain from `exact-4100.ts` gets turn 3 = turn 2 + exactly 1,500 tokens
(reply + new message). RUNS=4 then 6:

| chain                          | turn 3 | cached    | full price | clean |
| ------------------------------ | ------ | --------- | ---------- | ----- |
| Gemini 4,100 → +1,000 → +1,500 | 6,600  | **3,051** | 3,549      | 5/5   |
| Gemini 4,100 → +2,100 → +1,500 | 7,700  | 4,151     | 3,549      | 3/3   |
| OpenAI 4,100 → +1,000 → +1,500 | 6,600  | 5,097     | 1,503      | 8/8   |
| OpenAI 4,100 → +2,100 → +1,500 | 7,700  | 6,197     | 1,503      | 10/10 |

- **Refuted my prediction** that Gemini’s turn 3 (+1,000 chain) would resume
  at turn 1’s end (4,101): it is within turn 3’s limit (6,600 − 2,049 =
  4,551) and better than 3,051, but turn 3 always got 3,051 (turn 2 −
  2,049). Turn 1’s end point did not survive turn 2, which had resumed from
  turn 1’s other point (2,051).
- Working rule (hypothesis): a request keeps the point it resumed from plus
  its own two new points (end, end − 2,049); the previous request’s other
  points are dropped. It fits the boundary probe (an old point survived only
  when the next request had resumed from it). So small appends keep costing
  2,049 tokens per turn, with no way back to an older, better point.
- In two +1,000 trials turn 2 carried the hidden block (cached 0), yet turn 3
  (no block) still cached exactly 3,051.
- Gemini blocked 12 of 20 trials (`blockReason: OTHER`), mostly on turn 3.
  Same caveat as before: replies are sent back without their signature.
- Claim tests added to `src/claims/exact-4100.test.ts` (4 more).

Added `TURN1`, `APPENDS` and `PROVIDERS` options to `run-exact-turn3.ts` and
ran the 4,000-token chain on Gemini (RUNS=6): 4,000 → +2,100 → +1,500 gives
turn 2 cached 0 (6,100 full price) and **turn 3 cached 4,051** (turn 2 −
2,049), 2 clean of 6 (4 blocked). The rule predicts this: a request under the
minimum saves nothing, but turn 2 (6,100) does, so turn 3 can resume there.

The site post’s four figures now show all three turns from `exact_4100.csv`
and `exact_turn3.csv`.

## 2026-10-16: 2,500 instead of 2,100, and the branch test (`run-exact-branch.ts`)

The user asked for 2,500 instead of 2,100 tokens as the larger second message
(clearer than 2,100, which sits close to the 2,049 edge). New rows (the 2,100
rows stay in the CSVs under their own label):

- exact_4100: Gemini 4,100 + 2,500 → 4,101 cached / 2,499 full (3 clean);
  4,000 + 2,500 → 0 (4 clean). OpenAI 4,097 / 2,503 and 3,997 / 2,503 (5/5).
- exact_turn3: Gemini 4,100 → +2,500 → +1,500 → turn 3 **4,551** (3 clean);
  4,000 → +2,500 → +1,500 → turn 2 0, turn 3 **4,451** (1 clean; 13 of 14
  blocked). OpenAI → 6,597 (6/6).
- Claim tests moved to 2,500 (`exact-4100.test.ts`), plus one for the
  4,000-token three-turn chain.

**Branch test.** The user doubted that Gemini’s turn 3 (+1,000 chain) really
ignores turn 1’s end breakpoint. Decisive test: turn 1 (4,100), turn 2
(+1,000), then a _branch_ from turn 1 (+2,500, a different new message);
control: the same branch with no turn 2 sent.

| provider           | after turn 2    | control (no turn 2) |
| ------------------ | --------------- | ------------------- |
| Gemini 4 argon     | **3,051** (5/5) | **4,101** (5/5)     |
| OpenAI gpt-5.6-sol | 4,097 (6/6)     | 4,097 (6/6)         |

**Confirmed: sending turn 2 removes turn 1’s end breakpoint on Gemini 4.**
The same branch caches 4,101 straight after turn 1, but only turn 2’s
3,051 once turn 2 was sent. That held in the 2 trials where turn 2 carried the
hidden block and cached 0 too, so it doesn’t depend on which point turn 2
resumed from. OpenAI keeps turn 1’s end either way. (The site figure’s
caption, "turn 1’s end breakpoint is dropped", stands.)

Site post: each conversation now has a totals row (cached and full-price
tokens over the three turns) and a cost line at $2 per million full-price
tokens and $0.10 per million cached, computed from the counts shown.

Harness slip: the two `it.each` OpenAI branch tests differed only in a
"(false)"/"(true)" suffix past character 100 of the test name, and recording
directories are named from the first 100 characters, so the second recording
overwrote the first and the "false" test failed on replay. Renamed them so the
variant comes first, removed the shared recording and its values, and
re-recorded just those two (`RECORD=new -t "OpenAI branch"`). Checked every
other `it.each` for the same risk: none. All 114 tests replay offline.

Not ruled out (by choice, not run): timing. The branch after turn 2 is sent
~6–10 s after turn 1, the control branch ~3 s after it, so a breakpoint that
simply expired within seconds would also explain the result. The claim stays
"after turn 2 was sent, turn 1’s end breakpoint was no longer available".
