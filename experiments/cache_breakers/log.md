# cache_breakers log

Chronological notes: what was tried, what was found.

## 2026-09-18: What exactly breaks the implicit prompt cache, and in what order?

Question as posed: for Anthropic, Google and OpenAI (Chat Completions and
Responses), what exactly breaks the implicit cache (model, reasoning level,
system prompt, messages, tool definitions, anything else), and in what order
are those parts laid out in the cached prefix?

Plan: one base request per API built from sections of known size (tools,
system, an early history exchange, a late history exchange, a final user
message), each tagged with a per-trial nonce so no two trials share a prefix.
Warm the cache with the base, change exactly one thing, and read the cached
token count. "Edit the start of section X" probes give each section's offset,
which recovers the render order; every other change is placed against those
offsets. Later: a tool-loop scenario that replays reasoning items and
signatures (OpenAI encrypted reasoning, Gemini `thoughtSignature`, Anthropic
thinking blocks).

Starting with one API and one model: OpenAI Responses, `gpt-5.6-sol` (sibling
for the model-switch variant: `gpt-5.6-luna`). Other APIs get their own
adapter in `src/providers/`.

### Manual probes before writing the harness (curl, not scripted)

Three quick curl probes against `gpt-5.6-sol` on Responses, ~3000-token
prompt of filler words, `prompt_cache_key` set, 2 s between calls:

1. Same request three times: cached 0 → 3018 → 3018 of 3021 input. The first
   call reports `input_tokens_details.cache_write_tokens: 3018`, a field that
   older models don't return. cached + written = input − 3 on every call.
2. One ~3000-token `instructions` string, then the same with a few words
   appended to its end: **cached 0**, not ~3000. Appending one word to the
   end: also 0. So on this model the cache does not match a token prefix
   partway into a block.
3. Split the same filler into a developer message and a user message (~1500
   each), then change only the tail of the second: cached 1509 (exactly the
   first message plus framing), written 1514. Changing it back to an
   already-seen tail: cached 3023.

Takeaway: for `gpt-5.6-sol` the cache matches at message boundaries, not at
the 128-token granularity OpenAI documented for earlier models. That makes
the section design work cleanly (every section is its own message or field),
and it is a finding in its own right. These probes aren't in a CSV; the
harness re-tests the same thing via the `*_edit_start` / `*_edit_end` probes.

### Pilot: `scripts/run-static.ts`, RUNS=1, all 44 variants → `results/static.csv`

Sections are ~1500 tokens each (`SECTION_WORDS=1500`); base prompt ~6150
tokens; `reasoning.effort: low`; 1.5 s between calls. Every base warmed on its
second call.

Probes:

- tools_edit_start, tools_edit_end, system_edit_start, system_edit_end: all
  cached **0**. Tools and `instructions` behave as one unit; the cache can't
  say which comes first inside it.
- early_edit_start/end, late_edit_start/end and final_edit all cached
  ~3050–3070: exactly the tools+instructions header. Even editing only the
  final 8-token user message lost the ~3000 tokens of history before it. So
  the base request did not leave a reusable checkpoint at each message
  boundary.

Other variants (single run each, to be confirmed):

- 0 cached: tools_remove_all, tools_reorder, tool_add, tool_remove_last,
  parallel_tool_calls_off (input +80 tokens: it is rendered into the header),
  model_switch, effort_medium, effort_none, json_schema_format (input +24),
  verbosity_high, cache_key_removed, cache_key_changed, service_tier_flex,
  service_tier_priority.
- Full hit: tool_schema_key_order, tool_strict_off,
  system_as_developer_message, system_as_system_message, content_as_parts,
  reasoning_summary, include_encrypted_reasoning, max_output_tokens,
  cache_retention_24h, store_true, metadata, safety_identifier,
  truncation_auto, append_turn.
- Header only (~3050): image_in_final, same as final_edit.
- Puzzle: tool_choice_required / none / function cached 6026–6077 of ~6160,
  i.e. everything but ~100 tokens, far more than final_edit kept. Needs
  repeats before reading anything into it.
- Errors: temperature and top_p are rejected by gpt-5.6-sol ("Unsupported
  parameter").

Next: RUNS=4 more for every variant.

### RUNS=4 more (5 per variant in total) → `results/static.csv`

220 rows, 44 variants × 5. Every trial warmed on its second base call, and
every variant that ran landed at the same checkpoint in all 5 trials; only
temperature and top_p have no data (both rejected by gpt-5.6-sol). The
pilot's picture holds with no exceptions.

Correction to the curl-probe takeaway above: the cache does not keep a
checkpoint at every message boundary. There are two: the end of the
tools+instructions header (~3060 tokens here) and the end of the whole
prompt. Every edit inside the history, including an 8-token change to the
last user message, falls back to the header and re-writes the whole history
(`cache_write` ≈ 3100). In the curl probe the first message was a developer
message, i.e. part of the header, which is why it looked like a message
boundary.

The tool_choice puzzle, resolved by the token accounting: for
tool_choice_required / none / function, `input_tokens` is unchanged,
`cache_write` is 0, and cached drops by a constant per choice (required −119,
none −72, function −128/129 in every trial). Nothing is invalidated; a fixed
tail at the end of the prompt is swapped and billed uncached. Ordinary
changes show cached + written = input − 3; these don't, which marks them as a
different mechanism.

Harness fixes along the way:

- `toEqual` ignores key order, so the "every variant changes the body" test
  wrongly failed tool_schema_key_order; it now compares serialised JSON.
- `@experiments/test`'s `it` dropped vitest's numeric timeout argument
  (`it(name, fn, 60_000)`); fixed in `packages/test/src/index.ts`.
- A recorded test reused a nonce from a timed-out attempt, so its first base
  call was already cached (6140). The `first_cached` check caught it; fresh
  nonces fixed it.
- `analyze.ts` now merges probes that land on the same offset into one
  checkpoint (`tools/system` at 0, `early/late/final` at ~3060), since the
  cache can't order sections inside a checkpoint.

Next: (1) does an edit fall back to the end of an earlier request rather than
the header (i.e. are old request-ends kept as checkpoints)? (2) the tool-loop
scenario with replayed reasoning items.

### Tool-loop scenario: `scripts/run-tool-loop.ts` → `results/tool_loop.csv`

Base = original input + the seed call's output items verbatim (reasoning
with `encrypted_content`, function_call) + a synthetic 200-word tool result.
Three pilot attempts before it worked:

1. The seed prompt "call tool X with query Y" got **0 reasoning tokens and no
   reasoning item** at effort low and medium, so there was nothing to replay.
   Asking for a small calculation first (4817 × 293, a letter count) reliably
   produces a reasoning item.
2. Some seeds returned no function_call even so. Cause: the base's
   `max_output_tokens: 256` was used up by ~240 reasoning tokens, so the
   response was `incomplete`. The seed call now uses 4096 and
   `tool_choice: required`, and the harness rejects any seed whose status
   isn't `completed`. Those rows were discarded (CSV deleted and rerun).
3. Dropping the reasoning item is a 400: "Item 'fc*…' of type
   'function_call' was provided without its required 'reasoning' item:
   'rs*…'". The API pairs them by `id`. Kept that variant (the error is the
   result) and added `drop_reasoning_strip_ids` and `strip_item_ids`.

Pilot, RUNS=1, all 11 variants (base ~6600 tokens):

- Full hit: strip_item_ids, reasoning_by_reference,
  output_items_by_reference, previous_response_id, then_user_turn (input
  grows by the appended turn only; earlier reasoning is not stripped when a
  new user turn starts).
- Back to ~6200 (the end of the seed request, i.e. just before the reasoning
  item): drop_reasoning_strip_ids, then_user_turn_no_reasoning,
  tool_output_edit. The tool-result edit loses the unchanged reasoning item
  and function_call too.
- 0: effort_medium.

That ~6200 fallback is new. In the static scenario every history edit fell
back to the header, but here the seed request ended inside the history, and
its end survives as a checkpoint. Hypothesis: checkpoints are the header end
plus the end of every earlier request. The `prev_turn_*` and `sibling_*`
probes (running now, 5 each) test it directly.

### Earlier-request checkpoints, and the tool loop at 5 runs

`run-static.ts`, VARIANTS=prev_turn_then_final_edit,
prev_turn_then_late_reply_edit, sibling_then_late_edit, RUNS=5 (15 rows);
`run-tool-loop.ts` RUNS=4 more (44 rows, 5 per variant in total). Every
condition agreed across all 5 trials.

Static probes:

- prev_turn_then_final_edit: cached ~5380 (vs 3054 for final_edit without
  the earlier request). prev_turn_then_late_reply_edit: same ~5385. With the
  previous turn sent once, an edit after it falls back to that request's
  end (header + early exchange + late user message), not to the header.
- sibling_then_late_edit: cached ~3050, the header only. A sibling request
  that shares the early exchange but then diverges leaves an entry that
  can't be partially reused: the match is whole entries, not the longest
  common prefix of an entry.

So on gpt-5.6-sol the reusable points are: the end of the header, and the
exact end of any earlier request (as long as the new request extends that
earlier request's full prompt). Nothing in between.

Tool loop, 5 runs each (base ~6600 tokens):

- control, strip_item_ids, reasoning_by_reference,
  output_items_by_reference, previous_response_id, then_user_turn: full
  hit. Token deltas: previous_response_id has the same input_tokens as the
  full replay; then_user_turn adds only the appended turn (+56/57), so no
  earlier reasoning is stripped.
- drop_reasoning_strip_ids: back to ~6200 (seed request's end). input drops
  by 106–221 tokens: the rendered reasoning. Cache write ~245.
- tool_output_edit: back to ~6200 too, writing ~390–430 tokens: the
  unchanged reasoning item and function_call are re-written along with the
  tool result.
- then_user_turn_no_reasoning: back to ~6200.
- drop_reasoning (ids kept): 400 on all 5 trials, as in the pilot.
- effort_medium: 0.

### Reasoning-effort sweep → `results/static.csv`

gpt-5.6-sol accepts effort `none`, `low`, `medium`, `high`, `xhigh`, `max`
(`minimal` is a 400: "Unsupported value … Supported values are: 'none',
'low', 'medium', 'high', 'xhigh', and 'max'"; checked by curl, not scripted).
Added a `rebase` hook so a variant can warm the base at a different level,
then generated: every ordered pair (28 new; low→medium and low→none already
existed as effort*medium / effort_none), `effort*<level>\_omitted`for each
level, and`effort_switch_back` (warm low, one request at medium, back to
low). Pilot RUNS=1, then RUNS=4 more: 35 variants × 5 = 175 rows.

- All 30 pairs: cached 0 in 5/5 trials each, with input_tokens unchanged. Effort
  picks a cache the way the model and service_tier do.
- effort_switch_back: 100% in 5/5. Each level keeps its own cache; a detour
  doesn't evict the original.
- Omitting `reasoning`: 100% only after warming at medium, 0 after every
  other level. The default is medium, and sending it explicitly is free.

Report: added generated outcome tiers (zero / fallback / tail / none /
rejected; `tier()` in `src/analyze.ts`) at the top of the findings, as the
headline view. `tail` is separated from `fallback` by cache_write = 0, which
is how tool_choice differs from a real fallback.

### Is "any system prompt edit resets to zero" just a minimum-size effect?

Challenge raised on review: maybe the header edits give 0 because what's left
before the edit is under some minimum cacheable size. Decisive test: the same
six header probes at SECTION_WORDS 300, 600 and 4000 (5 runs each, 90 rows;
the 1500 rows already existed). At 4000 the system prompt alone is ~4000
tokens and ~8000 unchanged tokens precede an edit at its end.

| probe (median cached / warm base) | 300       | 600       | 1500      | 4000        |
| --------------------------------- | --------- | --------- | --------- | ----------- |
| control                           | 1383/1383 | 2500/2500 | 6149/6149 | 16330/16330 |
| early_edit_start                  | 0/1384    | 1233/2500 | 3066/6161 | 8148/16320  |
| tools_edit_start / \_end          | 0         | 0         | 0         | 0           |
| system_edit_start / \_end         | 0         | 0         | 0         | 0           |

- Not a size effect: system_edit_end is 0 in 5/5 trials at 4000 words, with
  ~8× the minimum unchanged before the edit.
- A minimum does exist: at 300 words the ~690-token header isn't reusable
  on its own (early_edit_start → 0); at 600 (~1233 tokens) it is. So the
  minimum is between ~690 and ~1233 tokens, consistent with the documented 1024. The main runs' ~3060-token header is well clear of it.

The report's main analysis now uses only the 1500-word trials; the size
sweep has its own table (`<!-- report:sizes -->`).

### Minimum cacheable size: `scripts/run-minimum.ts` → `results/minimum.csv`

Two probes. `whole`: one instructions-only prompt of n words sent up to 3
times; hit = a repeat reports cached tokens. `header`: an n-word system
prompt (no tools) followed by ~3000 tokens of history, warmed, then the final
message edited; hit = the header is kept. Coarse grid 400–1600 words step 100
(26 rows), then fine grid 950–1010 step 4 × 2 runs (64 rows). No errors.

- whole: largest miss 1025 input tokens, smallest hit 1030 (cached 1027).
  The last 3 input tokens are never cached, so in cacheable tokens: 1022
  missed, 1027 hit.
- header: largest miss ≈1020 header tokens (header-only request 1034),
  smallest hit cached exactly **1024**.
- No overlap between hits and misses in either probe.

So the minimum is 1024 cacheable tokens, and it applies to each checkpoint
separately: a prompt far above 1024 still can't fall back to a header under 1024.

### Claim tests: the study must verify itself

Direction from review: someone else must be able to verify every claim by
running the tests alone, with the recordings committed as proof of work.
Added `src/claims/*.test.ts`, one test per blog claim, running the same
`runTrial` / `runMinimum` procedures live and asserting the stated outcome
(not recorded numbers). Added `recordedValue()` to `@experiments/test` so
nonces are fresh on every recording and identical on replay; without it a
live re-run could pass by hitting the previous recording's cache. The
new-experiment skill now requires this for every experiment.

## 2026-09-18: Anthropic Messages (claude-opus-5)

Adapter `src/providers/anthropic-messages.ts`, raw HTTP like the others, in
two modes because Anthropic only caches behind `cache_control`:
`anthropic_auto` (one top-level `cache_control`, the closest analogue of
implicit caching) and `anthropic_breakpoints` (explicit breakpoints at the
end of the tools, system, early exchange and late exchange: the 4 allowed).
Sibling model for model_switch: claude-sonnet-5. Server-side refusal
fallbacks deliberately not enabled: they add a routing variable.

### Refusals block the synthetic filler

- curl probe: random-word filler → `stop_reason: "refusal"`, category
  **bio**, on Opus 5 and Sonnet 5 (Haiku 4.5 answered). Refused requests
  reported `cache_creation_input_tokens` on every repeat and never a read, so
  a refusal can never be a valid trial; the adapter now turns one into an
  error `refusal (<category>)`.
- A grammar of plain sentences ("The quiet garden faces the old bridge.")
  passed as a system prompt alone, cached fine (4503 read on repeat).
- Pilot, RUNS=1, probes + control, both modes, with that filler: 14/20
  refused, category **cyber**. Isolation (12-ish sends each): refusals with
  or without tools and nonce tags; system-only never refused.
- Giving the filler a purpose (town-guide notes and summaries) made it
  worse: 11/12 refused.
- Seeded slices of a public-domain novel (Pride and Prejudice, chapters
  1–20, `data/`): 12/12 accepted. That is now the `book` filler style;
  OpenAI keeps the `words` style, which is byte-identical to before, so its
  recordings and CSVs stand.

Signals from the 6 non-refused pilot trials (n=1, grammar filler): in auto
mode every edit gave 0 cached, including late-history edits; with
breakpoints, a system edit kept exactly the tools (3639 tokens).

Housekeeping: results are now one CSV per adapter
(`results/<scenario>/<adapter>.csv`). The OpenAI rows moved unchanged
(verified by diff). The 20 Anthropic pilot rows above were dropped: they
used the superseded filler.

### OpenAI claim tests recorded (proof of work)

`src/claims/*.test.ts`: 93 tests across 7 files. Recording took three
passes, each exposing a harness bug:

1. First live pass: 83/93 passed, but only 21 HARs were written. Cause: the
   `@experiments/test` wrapper copied vitest's own `.each` onto `it`, so
   every `it.each` test ran live, unwrapped, and recorded nothing; a
   "replay" run then silently hit the live API for them. `.only` and
   `.concurrent` had the same hole. Fixed by wrapping every flavour, with a
   guard test (`packages/test/src/index.test.ts`) that fails if any flavour
   can reach the network in replay mode.
2. The fixed `.each` passed options in vitest 3's `(name, fn, options)`
   order, which vitest 4 rejects; the guard test now covers a timeout too.
3. The tool-loop claims asserted the base's first call was uncached. It
   can't be: the seed call is the previous request, and its end is a
   checkpoint. The check is now "not fully cached" for the tool loop.

Also fixed `recordedValue`: under RECORD=new, a test with no recording gets
a fresh nonce even if an interrupted run stored one, since a reused nonce
would hit the previous run's cache.

Final: 93/93 passed live; `pnpm test` replays all of them offline in <1 s.

### Anthropic pilot with book filler, RUNS=1 → `results/static/anthropic_*.csv`, `results/tool_loop/anthropic_*.csv`

All static variants in both modes plus the tool loop, 1500-word sections
(~11.9k tokens: the book text tokenizes at ~2 tokens/word). 126 trials, 7
errors: temperature and top_p ("deprecated for this model", both modes),
thinking_signature_edit (400 "Invalid `signature` in `thinking` block", both
modes), and 1 residual refusal (cyber) on an auto-mode prewarm. The user
asked not to repeat these batches (cost); confirmation comes from one-trial
claim tests instead.

Auto mode (one top-level cache_control):

- Every edit, anywhere (tools, system, any history message, the final
  8-token message), → 0. Only a previous request's end is reusable:
  prev_turn_then_final_edit / \_late_reply_edit → ~10.5k of ~11.9k. A
  diverging sibling → 0.
- → 0: tool add/remove/reorder/remove_all, model_switch, tool_choice any and
  tool, image_in_final, json_schema_format, inference_geo_us,
  thinking_disabled, all 20 effort pairs, effort omitted after anything but
  high, effort_per_message (beta).
- no effect: tool_choice none, disable_parallel_tool_use, system_as_blocks,
  system_message_appended, tool_strict_on, tool_schema_key_order,
  content_as_parts, max_tokens, stop_sequences, metadata_user_id,
  service_tier standard_only, cache_ttl_1h, cache_mode_switch,
  thinking_adaptive_explicit, thinking_display_summarized,
  effort_high_omitted (so the default effort is high).

Breakpoints mode:

- Order tools → system → early → late: tools edit 0; system edit keeps
  ~3350 (the tools); early edit ~6270; late edit ~9100.
- tool_choice any / tool → ~6300/6125 (tools + system kept, messages lost),
  as documented. json_schema_format → 3433: keeps only the tools, so the
  output format is rendered with or before the system prompt.
- model_switch, inference_geo_us, thinking_disabled, all effort pairs → 0
  even here, so on Opus 5 those sit ahead of the tools.
- effort_per_message (beta) → 0 in both modes, although documented as
  cache-preserving. Added `beta_header_only` to test whether the beta
  header alone changes the cache key.

Tool loop (auto): drop_thinking is accepted (no 400, unlike OpenAI's
reasoning item) and, like tool_result_edit and then_user_turn_drop_thinking,
lands exactly on the base's first_cached, i.e. the seed request's end.
then_user_turn keeps 100%. The breakpoints-mode tool loop is uninformative
(its last breakpoint precedes the tool turn) and is left out of the claims.

Claim tests for Anthropic use 600-word sections (every checkpoint still

> 1000 tokens, above Opus 5's 512 minimum) to halve cost.

### Anthropic claim tests, and final scope

`src/claims/anthropic-{auto,breakpoints,effort,tool-loop}.test.ts`: 81 tests
at 600-word sections (~$6 live). All 81 passed on the first live recording
and replay offline. They confirm every pilot finding at a second section
size. New from them:

- `beta_header_only`: sending the `mid-conversation-output-config-2026-07-01`
  beta header with no other change reads 0 (write ~5200), exactly like
  `effort_per_message`. The header changes the cache key; the effort
  message itself isn't what breaks it.
- Tool loop: drop_thinking and tool_result_edit land on exactly the base's
  `first_cached` (the seed request's end), a within-trial check that is
  sharper than comparing two trials.

Claim nonces are now keyed by adapter; the 96 stored OpenAI keys in
`values.json` were migrated to the new names (no re-recording). Full suite:
212 tests replay offline in <1 s.

Scope decision (user): OpenAI Responses and Anthropic Messages, one model
each. Gemini and Chat Completions are out. The blog now has a side-by-side
comparison, one section per API, and a Scope section saying so.

### Correction: history edits in a real thread (`scripts/run-thread.ts` → `results/thread/`)

Review caught an overclaim. The blog said an edit anywhere in the history
"falls back to the header and re-writes the whole history" (OpenAI) and
"reuses nothing" (Anthropic automatic). Those came from the static probes,
where the whole history is sent in one request and no earlier request ever
ended inside it. The user had seen mid-thread cache hits in practice, and
was right that the claim didn't follow from a setup with one message
exchange.

Decisive test: a 6-turn thread sent turn by turn (~150-word user messages,
~500-word fixed assistant replies), then one probe: edit u4, branch at u4,
cut after a4, or edit u4 after a 60 s pause. Three hypotheses give
different numbers: reuse up to the previous request's end; up to the edit
(longest prefix, which would include the ~690-token reply a3); or 128-token
blocks.

Pilot, OpenAI, 1 trial each: every probe landed **exactly** on the previous
request's end (2789/2789, 2761/2761, 3442/3442, 2764/2764), ~690 short of
the next request's end, and not on a 128 multiple. So: the cache holds
mid-thread, at earlier requests' ends only.

Blog rewritten to lead with the thread result and to label the static
probes as the edge case (a history never sent turn by turn). Added
`src/claims/thread.test.ts` for both APIs, and a skill rule: state claims
at the scope of the setup, and test the realistic case before generalising.

### Anthropic to n=5, and everything checked for agreement

RUNS=4 more for both Anthropic modes (static) and the auto tool loop, at
the same 1500-word sections as the pilot (~$80). 3 more stray refusals
(1 reasoning_extraction, 2 cyber over the whole batch) and the expected
rejections (temperature, top_p, thinking_signature_edit). Topped up the
short conditions with targeted runs: effort_xhigh_to_low, effort_switch_back,
and beta_header_only (added after the pilot) in both modes.

Thread probes to n=5 on both APIs: 40/40 trials landed exactly (±0 tokens)
on the previous turn's end, ~680 (OpenAI) / ~1230 (Anthropic) short of the
next turn's end.

Agreement check (each usable trial classified on its own): every
condition in static/openai_responses (82), static/anthropic_auto (70),
static/anthropic_breakpoints (70), tool_loop/openai_responses (11) and
tool_loop/anthropic_auto (7) has ≥5 usable trials, all in the same tier.
tool_loop/anthropic_breakpoints stays at n=1 and isn't reported: its last
breakpoint precedes the tool turn, so it can't show anything.

### "Doesn't it match in 128-token blocks, even mid-message?" Model-dependent.

The user expected block matching (OpenAI's docs: cache hits in 128-token
increments of the longest prefix). gpt-5.6-sol never does that. Pilot on
older models (`scripts/run-models.ts` → `results/models/openai_responses.csv`,
2 runs each of control / system_edit_end / early_edit_end / final_edit):

| model         | edit end of instructions | edit end of history msg 1 | edit final msg |
| ------------- | ------------------------ | ------------------------- | -------------- |
| gpt-4o        | 2816                     | 2816                      | 6016 (all)     |
| gpt-4.1       | 0, 0                     | 0, 2816                   | 6016           |
| gpt-5         | 2944                     | 3712                      | 6016           |
| gpt-5.4 / 5.5 | 2560                     | 2560                      | 5632 (all)     |
| gpt-5.6-sol   | 0                        | ~3060                     | ~3060          |

Every count on the older models is a multiple of 128 (gpt-4o, 4.1, 5) or
512 (5.4, 5.5), and they reuse part of an edited message. So the user's
experience matches older models; gpt-5.6-sol changed the rule. gpt-4.1's
zeros look like routing misses.

A 6-model position sweep was started and then stopped by the user (scope:
gpt-5.5 only). It had finished gpt-4o and gpt-4.1 (34 rows); those two
batches were removed from the models CSV, which keeps the 40-row pilot.

Decision: add gpt-5.5 as a fourth comparison column (adapter
`openai_responses_gpt-5.5`, sibling gpt-5.4), full static variant set at
n=5, plus a position sweep: one word replaced at 8 evenly spaced points in
`instructions` and in history message 1 (`sweep_*`, own group, kept out of
the comparison).

gpt-5.5 pilot (RUNS=1): every nonzero count is 2560, 4608 or 5632 (odd
multiples of 512, i.e. maybe points every 1024 from 512). Instructions
edits in the first ~2/3 → 0, later → 2560. History-message edits → 2560,
except 2 of 8 → 0 (misses?). late_edit → 4608 (gpt-5.6-sol: ~3060). final
and prev-turn edits keep all. Same as 5.6-sol: tools/model/effort/schema/
verbosity/routing → 0, default effort medium, tool_choice tail (128).
New: `max` effort is rejected on gpt-5.5, as are temperature and top_p.

### gpt-5.5 at n=5 → `results/static/openai_responses_gpt-5.5.csv`

98 variants × 5 (plus the pilot). Every condition has 5 usable trials.
Rejected: effort pairs involving `max` ("'max' is not supported with the
'gpt-5.5' model"), temperature, top_p.

Sweep, all 5 runs: instructions edits at 5–67.5% → 0; at 80% → 2560
(5/5); at 92.5% → 2560 (3/5, 2 misses). History message 1, every position
→ 2560 (bar 3 misses). late_edit_end → 4608 (5/5), late_edit_start → 2560.
So the reusable points in this prompt were 2560 and 4608 (2048 apart; the
one at 512 would be under the 1024 minimum) plus the prompt end rounded down
to 512. A finer sweep would be needed to state the spacing as a general
rule; the blog states it for this prompt only.

Random full misses: 9/195 gpt-5.5 trials that should have reused tokens
read 0 (4.6%): final_edit, prev_turn_then_final_edit,
system_as_system_message, reasoning_summary and sweep points. 0/145 on
gpt-5.6-sol, 0/270 on Anthropic. Claim tests for gpt-5.5
(`src/claims/gpt-5.5.test.ts`, 11 tests, passed live) retry once on a
total miss when the claim is that something is kept.

Report: gpt-5.5 is a fourth column in the comparison; sweep variants have
their own group and are kept out of the comparison and tiers; rejected
effort pairs no longer count as a "fall back" in the collapsed effort row.

Two harness fixes from the gpt-5.5 work:

- `tier()` called gpt-5.5's history edits a "small tail" (45% kept):
  gpt-5.5 reports `cache_write_tokens: 0` on every request (425/425), so
  "nothing written" alone doesn't identify the tool_choice tail. A tail now
  also needs ≥90% kept. Regression test in `analyze.test.ts`.
- A gpt-5.5 claim hit a real miss while recording and retried, but the
  retry reused the same nonce key; under RECORD=new that regenerated and
  overwrote the first attempt's nonce, so replay couldn't find the first
  request. Retries now take their own key (`attempt`); that one test was
  re-recorded.

### gpt-5.6-luna (pilot, 2 runs) → `results/models/openai_responses.csv`

control, system/early/late/final edits and the 16 sweep points, 2 runs
each, 42 trials, no errors. Same as gpt-5.6-sol: every instructions sweep
point → 0; every history-message-1 sweep point, early/late edits and the
final edit → ~3050–3070 (the tools+instructions header), not block
multiples and flat across positions. So message-level matching arrived with
the 5.6 generation, not with sol alone.

### gpt-5.5 threads, and the comparison table rebuilt around concepts

`run-thread.ts` on gpt-5.5, RUNS=5 (20 trials, no errors). The thread's own
reads were 0; 0; 1536; 2560; 2560; 3584 (block points only).

- edit*u4 / edit_u4_after_60s / branch_at_u4: 1536 in 14 of 15 non-miss
  trials (one edit_u4 kept 2560; one missed with 0), i.e. a block \_before*
  the previous turn's end (2560).
- truncate*after_a4: 3584 in 5/5, \_past* the previous turn's end (2560),
  into reply 4.
  So gpt-5.5 matches the longest prefix shared with any earlier request,
  rounded down to fixed points. Every nonzero count across static and thread
  runs is 512 + 1024k (1536, 2560, 3584, 4608, 5632); the earlier "2048
  apart" reading came from the thinner single-request data and was wrong.

Claim tests: `src/claims/gpt-5.5.test.ts` gained 3 thread claims (retry
once on a total miss, separate nonce key per attempt). The edit/branch
claim is "lands on a block point, never past the previous turn's end",
because a single recorded trial hit 2560 = the previous turn's end; "always
before it" would have been an overclaim.

Report, after review: the comparison table is now the headline, directly
under the intro. Rows are concepts across APIs (`src/concepts.ts`), e.g.
one "service tier" row with OpenAI priority/flex and Anthropic
standard_only; every row states the change from its default; cells are one
line ("resets to 0", "no effect", "keeps N%" only when partial, no n since
n=5 is stated once); thread rows come first; missing data says "not
tested", settings an API lacks say "n/a". Variant descriptions now state
their defaults too.

Comparison cells now describe the cache state, not a percentage: "fully
cached", "nothing cached", or what was kept ("keeps tools and system
prompt", "keeps all but the last reply and final message", "…and part of
the system prompt" for gpt-5.5's blocks). Names come from landmarks measured
per adapter (the probes that stop exactly at a section boundary or the
previous turn's end); unmeasured boundaries fall back to the sections'
roughly equal sizes, and gpt-5.5 borrows gpt-5.6-sol's boundaries (same
prompt and tokenizer). Exact shares are in each cell's hover title.
History-message rows are split into "first character" and "append a word",
since gpt-5.5 treats the two differently.

### Filling the "not tested" / "n/a" gaps

- OpenAI mid-conversation `developer` message (`system_message_appended`,
  new variant), n=5 on gpt-5.6-sol and gpt-5.5: fully cached every time
  (sol cached = base, 5.5 5632/5632). It had shown "n/a", which was wrong:
  Responses supports it, it just wasn't tested.
- Anthropic breakpoints in a real thread: `run-thread.ts` now marks tools,
  system and each request's last message (the usual moving breakpoint) in
  breakpoints mode. n=5: 20/20 trials landed exactly (±0) on the previous
  turn's end, same as automatic caching.
- Removed the temperature/top_p row from the comparison: every model rejects
  both, so it says nothing about caching.

Claim tests extended (thread claims for breakpoints; developer message in
no-effect); 237 tests replay offline.

### Correction: gpt-5.5 thread edits don't fit "longest prefix to a block"

Placing each gpt-5.5 thread stop by message (user-message ends come from
the thread's own request sizes): appending a word to user message 4, or
replacing it, cached 1536 tokens = through user message 1 (~1400) and part
of reply 1, in 14 of 15 non-miss trials. The edit sits at ~3440 and a 2560
point existed before it (turns 3 and 4 both read 2560), yet it was reused
once. So the earlier write-up ("longest prefix shared with any earlier
request, rounded down to a point"; "fell back to the last block before the
edit") was wrong for threads. The single-request probes do fit "last point
before the edit". The blog now reports the observations and says the
thread rule is unresolved. Claim tests are unaffected (they assert only
"lands on a block point, never past the previous turn's end" and the cut's
result).

Comparison wording: cells now say "caches …"; thread cells name the exact
stopping message (majority across trials, spread in the hover title).

gpt-5.5 cells now report the block point in tokens ("caches up to a fixed
block point (1536 tokens, of ~3451 unchanged), short of the previous turn")
instead of naming a message: where a fixed block lands depends on message
sizes, so "part of reply 1" was incidental to this prompt and could as
easily have been inside the edited message.

GitHub Pages: added `_config.yml` (primer theme; code, packages and HTTP
recordings excluded from the site), an "Experiments" table in the README
(the site index), and a publishing step in the skill. No front matter
needed: Pages enables optional-front-matter, titles-from-headings and
relative-links. Local `github-pages` build: 1.2 MB, index + report + blog/log
pages + CSVs + data; in production mode links get the repo prefix. A
Liquid-looking string in the README broke the first build and was reworded.

### Blog figures (first four, for review)

`scripts/export-blog-data.ts` writes the blog post's `data.ts` (in the site
repo) from the results CSVs, so the figures can't drift from the data. Each
figure draws request 1, request 2 with the changed part ringed, then one row
per API showing what request 2 read from cache. All APIs share one layout
measured on gpt-5.6-sol (header, previous-turn and prompt ends from the
probes that stop there); two splits aren't measurable from cache reads and
use the fixture's sizes: tools vs system prompt (equal) and, in the thread,
user message vs reply (~160:500 words). Anthropic counts are mapped onto
the layout at its own measured boundaries; gpt-5.5's are used as tokens
(same prompt and tokenizer as sol). First four drawn: thread edit, resend,
tool edit, system prompt edit.

### Thread probe: a word appended to reply 4 (`edit_a4`)

Asked in review: we had edited user message 4 but never a reply mid-thread.
New probe `edit_a4` in `src/thread.ts`, n=5 on all four columns.

- gpt-5.6-sol, Claude automatic, Claude breakpoints: 15/15 exactly on
  request 4's end (through user message 4; reply 4 onward re-billed).
- gpt-5.5: 0 (miss), 3584, 2560, 3584, 3584. 3584 is past user message 4
  (~3445) and before the edit at the end of reply 4: reuse reached partway
  into the changed message, as block matching predicts (and unlike the
  edit_u4 result, which fell back to 1536).
  Claim tests added (thread claims for the three request-end columns;
  gpt-5.5: block point, never past the edit). Blog post figure added.

### Blog post: every comparison row drawn, table at the top

Refactor: the comparison (rows, cells, wording) moved out of
`build-report.ts` into `src/comparison.ts`, used by both the experiment page
and the blog export, so they can't disagree (the page's table was verified
unchanged apart from the reply-4 row's new position). Concepts got anchor
ids. `scripts/export-blog-data.ts` now writes TABLE (the comparison) and
CASES (48 drawings: 5 thread rows and 43 concepts), each an explicit list of
requests (edits ringed, appended parts ringed, parameter changes named in a
tag), then the last request as each API billed it (cached tokens, or
"rejected by the API" / "no such setting" / "not tested").

Added the baseline the review asked for: a conversation that only grows.
Each thread trial already sent request 6 (request 5 plus reply 5 and user
message 6); its cache read is the baseline. gpt-5.6-sol and both Claude
modes read all of request 5 in every trial; gpt-5.5 read 3584 of ~4124,
leaving the tail after its last block point at full price even on a normal
next turn. Asserted in the existing thread claim tests (no new recordings).

Drawing fixes found by looking at renders: the final message rounded to
−1 tokens and vanished once billed (floored at 8); the tool-description
drawing's tag described a different variant from the one drawn; boundary
counts a few tokens off the layout drew hairline slivers (snapped within
40 tokens for message-boundary APIs; gpt-5.5 stays raw).
