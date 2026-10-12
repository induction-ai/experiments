# pattern_following log

Chronological notes: what was tried, what was found.

## 2026-10-06: What does an agent do next when its transcript is edited?

An agent's next move depends only on the request it receives, so the
transcript it sends back can be rewritten before the model ever sees it.
This experiment takes one real request and edits its history to see how
the model's next turn changes: delete messages, rewrite tool calls, alter
tool results, or insert turns that never happened.

Captured the final Responses API request from one run of the Toolathlon
`sales-accounting` task (model `gpt-6.1-sol`, reasoning effort medium, the
run scored 1). The request holds the system prompt, the user task, six tool
calls with their outputs and 47 tool schemas. The original reply was a short
final answer saying five transactions were added. Both are in `data/`.

Built a local sandbox (`pnpm --filter @experiments/pattern_following dev`) that
edits any item in that request, sends it straight to the OpenAI Responses API
and shows the new next turn beside the original. Mutations to study get
picked from what turns up in the sandbox.

Switched the captured request to a tau-banking conversation: task
`banking_021`, a customer asking whether the cash back on two credit cards
was calculated correctly. Model `gpt-6.1-sol`, reasoning effort xhigh; the
task passed on all four of its runs in that benchmark. The final request has
46 input items (system prompt, three customer turns, 17 tool calls with their
outputs, five encrypted reasoning items) and 15 tool schemas. Its tools
cover identity verification, account and transaction lookups, a policy
search and handing tools to the customer, so there is more varied history to
edit than in the spreadsheet task. In the original reply, the agent tells the
customer that both purchases look like cash back miscalculations but it
cannot yet rule out legitimate adjustments.

Tried replacing every `KB_search` query in the final request with `...`
(by hand, in the sandbox). The final reply did not change in any
meaningful way. That test could not show copying: on the final turn the
agent writes to the customer and searches nothing, the search results were
left in place, the encrypted reasoning before each batch may still carry the
original plan, `...` is a useless query rather than a harmless style, and it
was one sample.

Next design: cut the history right before the agent's last batch of searches
(three parallel `KB_search` calls in the original run; 34 items, encrypted
reasoning kept) and compare five setups, `RUNS` replies each:

- `control`: unedited
- `snake_1`, `snake_3`, `snake_all`: the 1, 3 or all 7 most recent earlier
  queries rewritten in snake_case, with search results unchanged
- `serial`: each parallel batch rewritten as one call followed by its result
  (turn 6's five calls, turn 7's three)

Copying is supported if the snake_case share of new queries rises with the
number of styled queries, and if `serial` makes fewer calls per turn than
`control`. Script: `scripts/run-mimicry.ts` → `results/mimicry.csv`.

Pilot, `RUNS=1` (one reply per setup, 5 requests, no errors). Edited calls
keeping their original `fc_…` ids were accepted. No reply used snake_case,
including `snake_all` (0 of 3 queries). Tool calls per reply: control 1,
snake_1 3, snake_3 1, snake_all 3, serial 1, against 3 in the original run,
so the call count varies a lot between samples of the same history. About
30.8k input tokens per request, almost none cached (0 to 2,604), 290 to 427
output tokens. One sample per setup says nothing about rates yet.

Seven earlier queries may be too few examples to copy from, so added a second,
much longer conversation alongside banking_021: tau-banking `banking_056`
(gpt-6.1-sol at xhigh, passed). A
landscaping business owner looks for a better business checking account and
moves money into savings. Its final request has 158 items and about 175k
input tokens. Cut before its last batch of searches (three parallel
`KB_search` calls, as in banking_021), it keeps 129 items with 39 earlier
searches, 12 of them in parallel batches. Three of those queries are a single
word (`Cobalt`, `Sky`, `sweep`), so styling them only lowercases them.

Each conversation now has its own folder under `data/` and its own CSV under
`results/mimicry/`; the pilot rows above moved to
`results/mimicry/banking_021.csv`.

## 2026-10-07: How many `...` searches before the agent copies them?

New approach: find how many examples it takes. On banking_021, cut before the
last batch of searches, every earlier search query becomes `...`, and N
synthetic `...` searches are appended to the end of the history. Each one is
answered by one of the conversation's 7 real search results in turn, so
repeated identical results don't look like a stuck loop. A reply counts as
copying when a query it writes is exactly `...`.

Plan: a doubling sweep, N = 0, 4, 8, 16, 32, 64 with 5 replies each (7 to 71
`...` searches in the history), then narrow down between the two counts where
copying turns on. At N = 64 the request is roughly 245k input tokens, just
under the 272k point where per-token pricing doubles. Script:
`scripts/run-dots.ts` → `results/dots/banking_021.csv`.

Pilot, `COUNTS=0,64 RUNS=1` (2 requests, no errors):

- N = 64 (71 `...` searches in the history): the agent made one search with
  query `...`, with 0 reasoning tokens and 19 output tokens in total. 255,665
  input tokens, 2,604 cached.
- N = 0 (7 `...` searches): the agent did not search at all. It went straight
  to giving the customer the two dispute tools, which is what it did on the
  following turn of the original run. 453 reasoning tokens.

So at N = 0 there is no query to copy. Each count should be read as the share
of replies that send a `...` search, out of all replies, not out of replies
that search. Reasoning tokens are worth tracking alongside it: the copying
reply did no reasoning at all.

Full sweep: N = 0, 4, 8, 16, 32, 64 × 5 replies (30 requests, no errors),
pooled with the 2 pilot rows. A reply copies if it sends a `...` search.

| Added | `...` in history | n   | Copied | Searched at all | Skipped to giving dispute tools |
| ----- | ---------------- | --- | ------ | --------------- | ------------------------------- |
| 0     | 7                | 6   | 1      | 5               | 1                               |
| 4     | 11               | 5   | 0      | 5               | 0                               |
| 8     | 15               | 5   | 0      | 0               | 5                               |
| 16    | 23               | 5   | 1      | 1               | 4                               |
| 32    | 39               | 5   | 1      | 1               | 4                               |
| 64    | 71               | 6   | 5      | 5               | 1                               |

- Copying jumps between 32 (1/5) and 64 (5/6). Below that it is rare and
  flat: 1/6, 0/5, 0/5, 1/5, 1/5.
- Copying lines up with skipped reasoning. Seven of the 8 copying replies used
  0 reasoning tokens and exactly 19 output tokens (one `KB_search("...")`
  call). None of the 24 non-copying replies used 0 reasoning tokens (minimum
  81). The one exception is at N = 0: three parallel `...` searches after 117
  reasoning tokens.
- Before copying sets in, the agent stops searching. At N = 0 and 4 it mostly
  wrote real queries (9 of 11 replies). From N = 8 up, replies that did not
  copy skipped searching and gave the customer the dispute tools, the step
  that follows in the original run.
- Five replies per count can't separate 16 and 32 (1/5) from 0 (1/6). The
  turning point lies somewhere in 32 to 64. Next: COUNTS=40,48,56.

Input tokens: 30,733 (N = 0) up to 255,665 (N = 64). Repeats at the same count
were almost fully cached.

Narrowing run: N = 40, 48, 56 × 5 replies (15 requests, no errors).

| Added | `...` in history | n   | Copied | Skipped searching |
| ----- | ---------------- | --- | ------ | ----------------- |
| 40    | 47               | 5   | 4      | 1                 |
| 48    | 55               | 5   | 5      | 0                 |
| 56    | 63               | 5   | **1**  | 4                 |

- Not a clean threshold. 47 and 55 examples copy (4/5, 5/5), then 63 drops to
  1/5 before 71 is back at 5/6. Pooled: 3 of 26 replies copied with 39
  examples or fewer, 15 of 21 with 47 or more.
- The reasoning split holds across all 47 replies: 17 of 18 copying replies
  used 0 reasoning tokens (and 19 output tokens), none of 29 non-copying
  replies did (minimum 81).
- Possible cause of the dip at 63, not tested: the added searches go through
  the 7 real results in turn, so which result comes last depends on N. N = 56
  is the only count whose last pasted result is result 7, the result of the
  most recent real search. With 5 replies, the dip may also be noise.

More replies at the dip: N = 48, 56, 64 × 10 replies (30 requests, no errors).

| Added | `...` in history | This run                                  | Pooled   |
| ----- | ---------------- | ----------------------------------------- | -------- |
| 48    | 55               | 10/10 copied                              | 15/15    |
| 56    | 63               | **0/10** copied, all 10 skipped searching | **1/15** |
| 64    | 71               | 9/10 copied                               | 14/16    |

- The dip at 63 examples is not noise: 1 of 15 against 15 of 15 and 14 of 16
  on either side. Something about the N = 56 history stops copying.
- Leading suspect, still untested: which result comes last. 56 is a multiple
  of 7, so it is the only count whose last pasted result is result 7, the
  "Business Silver Rewards Card: Double Cash Back Promo" result (from the
  real query about a Business Bronze promotion). The other counts end on
  results 1, 4, 5 or 6.
- Reasoning split over all 77 replies: 36 of 37 copying replies used 0
  reasoning tokens and 19 output tokens; 0 of 40 non-copying replies used 0
  reasoning tokens (minimum 81).

Added a `START` option to `scripts/run-dots.ts`: the added searches' results
begin at real result START instead of the first. Runs with START ≠ 0 go to
`results/dots/banking_021_start<START>.csv`, so the existing CSV is untouched.
With START = 1, N = 56 ends on result 1 and N = 48 ends on result 7 ("Business
Silver Rewards Card: Double Cash Back Promo"), swapping which count ends on
result 7. If result 7 is what stops copying, N = 56 should copy and N = 48
should not.

Swap test, `START=1 COUNTS=48,56 RUNS=10` (20 requests, no errors):

| N   | Ends on             | START = 0    | START = 1       |
| --- | ------------------- | ------------ | --------------- |
| 48  | result 6 → result 7 | 15/15 copied | **1/10** copied |
| 56  | result 7 → result 1 | 1/15 copied  | **4/10** copied |

- Ending on result 7 stops copying. Moving it to the end of the N = 48
  history took copying from 15 of 15 to 1 of 10; the other 9 replies skipped
  searching and gave the customer the dispute tools.
- Moving it away from the end of the N = 56 history brought copying back only
  partly: 4 of 10, against 14 of 16 at N = 64, which also ends on result 1. So
  the last result explains most of the dip, but not all of it.
- Reasoning split still holds: all 5 copying replies used 0 reasoning tokens;
  the 15 others used 74 to 513.

Generalized `scripts/run-dots.ts` into `scripts/run-repeats.ts` with a
`STYLE` option (`dots` or `snake`); the package script is now `repeats`. Each
added search now repeats a real search in turn: its query in the chosen
style, plus that search's own result. For `dots` every query is `...` either
way, so the requests are identical to the earlier runs. Results go to
`results/<STYLE>/`.

Next: the same sweep with snake_case (`STYLE=snake`, N = 0, 4, 8, 16, 32, 40,
48, 64 × 5). Finding 2 tested snake_case with only 7 examples. If it is
copied past about 47 examples like `...`, copying is not limited to a
useless query. Here the styled queries come with matching, relevant results.

snake_case sweep, `STYLE=snake`, N = 0, 4, 8, 16, 32, 40, 48, 64 × 5 (40
requests, no errors). `results/snake/banking_021.csv`.

| Added | snake_case searches in history | Copied | Real queries | Skipped searching |
| ----- | ------------------------------ | ------ | ------------ | ----------------- |
| 0     | 7                              | 0      | 5            | 0                 |
| 4     | 11                             | 0      | 5            | 0                 |
| 8     | 15                             | 0      | 0            | 5                 |
| 16    | 23                             | 3      | 0            | 2                 |
| 32    | 39                             | 1      | 0            | 4                 |
| 40    | 47                             | 4      | 0            | 1                 |
| 48    | 55                             | 5      | 0            | 0                 |
| 64    | 71                             | 5      | 0            | 0                 |

- Same curve as `...`: 4 of 25 replies copied with 39 examples or fewer, 14 of
  15 with 47 or more.
- The copying replies did not write new snake_case queries. All 18 sent
  exactly the next query in the repeating cycle (the real search after the
  last one repeated), a single call with 0 reasoning tokens and 30 to 32
  output tokens. So this is the agent continuing a loop, not adopting a
  style. No reply wrote a new query in snake_case.
- Every non-copying reply reasoned (93 to 516 reasoning tokens) and either
  wrote real prose queries (N ≤ 4) or skipped searching (N ≥ 8).
- This suggests an explanation for the result-7 effect in the `...` runs, not
  yet tested: in the original conversation, the agent stopped searching right
  after search 7 and wrote to the customer. A history that ends on a repeat of
  search 7 has reached the point in the loop where the original moved on, so
  continuing the loop means not searching.

## 2026-10-08: Is a style copied without repetition?

The snake_case runs couldn't tell copying a style from replaying a loop,
because every added search repeated one of the 7 real ones. New setup
(`SOURCE=new STYLE=snake`): the 7 real queries in snake_case, then N added
searches that never repeat. They come from `data/kb_search_pool.json`: real
`KB_search` queries and results from five other passing tau-banking
conversations with the same knowledge base (banking_047, 048, 049, 052, 056).
The pool keeps only queries about credit cards, rewards, disputes or points
(115), and of those the 64 with the shortest results, in their original
order, so that N = 64 stays near 251k tokens. Their median result is 16.1k
characters, against 14.1k in banking_021.

A reply copies the style when it sends a fully snake_case query that is not
already in the history (`new_snake_queries`). Queries already in the history
are counted as `replayed_queries`. Sweep: N = 0, 4, 8, 16, 32, 40, 48, 64 × 5,
to `results/snake_new/banking_021.csv`.

Result (40 requests, no errors):

| Added | snake_case in history | New snake_case | Prose queries | Skipped | 0-reasoning replies |
| ----- | --------------------- | -------------- | ------------- | ------- | ------------------- |
| 0     | 7                     | 0              | 5             | 0       | 1                   |
| 4     | 11                    | 0              | 5             | 0       | 0                   |
| 8     | 15                    | 0              | 5             | 0       | 0                   |
| 16    | 23                    | 1              | 4             | 0       | 1                   |
| 32    | 39                    | 1              | 4             | 0       | 3                   |
| 40    | 47                    | 2              | 2             | 1       | 2                   |
| 48    | 55                    | 3              | 2             | 0       | 3                   |
| 64    | 71                    | **0**          | 3             | 2       | 0                   |

- The style alone carries over, but weakly: 7 of 40 replies wrote a new
  snake_case query, at most 3 of 5 per count (N = 48), against 15 of 15 when
  the searches repeated. No reply replayed an earlier query.
- Every one of the 7 style copies had 0 reasoning tokens. None of the 30
  replies that reasoned (78 to 516 tokens) wrote snake_case. Three other
  replies also had 0 reasoning but wrote prose.
- 4 of the 7 snake_case queries left this customer's problem and followed the
  other conversations the pool came from (`retention_offer_bonus_points_tool`,
  `crypto_cash_back_card_annual_fee`,
  `pending_credit_card_replacement_cancel_order_user_action`,
  `customer_credit_card_fee_question_request_human_transfer`). The other 3
  were about this customer's cash back dispute. A 0-reasoning prose reply at
  N = 32 drifted the same way (`silver rewards card getting started
eligibility requirements`).
- N = 64 dropped to 0 of 5 copies, with every reply reasoning. Unexplained;
  5 replies.

## 2026-10-08: Does the agent copy `...` when it visibly fails?

In the `...` runs every added search came back with a real result, so from
the agent's side `...` was a query that worked. New setup (`SOURCE=failed`):
the same history with every query set to `...`, but each of the N added
searches returns "No results found." The 7 real searches keep their real
results. If the agent still sends `...` at high N, it is continuing the
pattern despite it failing, not reusing a query that seemed to work. Same
counts as before (N = 0, 4, 8, 16, 32, 40, 48, 64 × 5) to
`results/dots_failed/banking_021.csv`; requests stay near 31k to 35k tokens.

Result (40 requests, no errors):

| Added | `...` in history | Copied | Real queries | Skipped searching |
| ----- | ---------------- | ------ | ------------ | ----------------- |
| 0     | 7                | 1      | 4            | 0                 |
| 4     | 11               | 0      | 5            | 0                 |
| 8     | 15               | 0      | 3            | 2                 |
| 16    | 23               | 0      | 0            | 5                 |
| 32    | 39               | 4      | 1            | 0                 |
| 40    | 47               | 1      | 1            | 3                 |
| 48    | 55               | 1      | 0            | 4                 |
| 64    | 71               | **5**  | 0            | 0                 |

- The agent keeps sending `...` even when it visibly fails: 5 of 5 at 71
  examples, 4 of 5 at 39. 11 of 20 replies copied at 39 examples or more.
- The counts in between are uneven (39: 4/5, 47 and 55: 1/5 each), unlike the
  run where `...` worked (47: 4/5, 55: 15/15). With 5 replies, the shape of
  the curve isn't settled, but the top count copies in both.
- The history stays small here: 30.7k input tokens at N = 0 up to 33.0k at
  N = 64. So copying at 71 examples doesn't need a long context; the number
  of repeated calls is enough.
- Reasoning split again: the 11 copies at N ≥ 32 all used 0 reasoning tokens
  and 19 output tokens; the one copy at N = 0 used 95. All 28 non-copying
  replies reasoned (67 to 516 tokens).

Firming up the middle, `...` failing: `SOURCE=failed COUNTS=32,40,48 RUNS=10`
(30 requests, no errors). Pooled with the earlier 5 per count:

| `...` examples | This run | Pooled |
| -------------- | -------- | ------ |
| 39             | 6/10     | 10/15  |
| 47             | 4/10     | 5/15   |
| 55             | 6/10     | 7/15   |

- The middle is a broad band, not a step: about half the replies copy
  anywhere from 39 to 55 examples (22 of 45), against 0 of 20 at 11 to 23
  examples and 5 of 5 at 71. The dip at 47 (5/15 against 10/15 at 39) is
  within what 15 replies per count can't separate.
- Reasoning split over all 70 failed-search replies: 27 of 28 copies used 0
  reasoning tokens (the exception is the copy at 7 examples); 0 of 42
  non-copies did.

Firming up the middle, `...` working: `COUNTS=32,40 RUNS=10` (20 requests, no
errors). Pooled:

| `...` examples | This run    | Pooled, working | Pooled, failing |
| -------------- | ----------- | --------------- | --------------- |
| 39             | 4/10        | 5/15            | 10/15           |
| 47             | 9/10        | 13/15           | 5/15            |
| 55             | (not rerun) | 15/15           | 7/15            |
| 71             | (not rerun) | 14/16           | 5/5             |

- Both setups agree on the ends (rare at 23 examples or fewer, near-total at 71) but not on the middle: working jumps between 39 and 47, failing sits
  around half from 39 to 55. Combined, 15/30 at 39, 18/30 at 47, 22/30 at 55.
  The write-up should give a band, not a threshold.
- Reasoning split over all 97 working replies: 49 of 50 copies used 0
  reasoning tokens; 0 of 47 non-copies did.

## 2026-10-08: Write-up

Rewrote `blog.md` around the main result: with enough repeats of the same
call, the agent stops reasoning and continues the pattern, even when the call
keeps failing. Across all 267 sweep replies, 106 of 108 copies used 0
reasoning tokens (both exceptions at 7 examples, the unedited count) and 156
of 159 non-copies reasoned (the 3 that didn't are in the never-repeated
snake_case sweep).

Added `scripts/build-report.ts`, which renders `blog.md` into `index.html`
with two charts built from the CSVs: share of replies that copied by number of
examples (three sweeps, 95% Wilson intervals; the 63-example point of the
`...`-with-real-results sweep is left out because its history ends on the
result that switches copying off), and reasoning tokens of copying vs
non-copying replies.

Added claim tests in `src/claims/` for every finding the blog states, each
sending the edited history 1 to 3 times and asserting the stated outcome.
They need recording before `pnpm test` passes offline.

## 2026-10-08: Does an instruction against `...` stop the copying?

Added an `INSTRUCTION` option to `scripts/run-repeats.ts`: the text is
appended on its own line after the end of the system prompt (`</policy>`).
First test: "Do NOT use ... as a KB_search query" on the `...` sweep with
real results, N = 32, 48, 64 (39, 55 and 71 examples) × 10, to
`results/dots_instructed/banking_021.csv`. Without the instruction those
counts copied 5/15, 15/15 and 14/16. If copying stays high, the repeated
calls override an explicit system-prompt rule.

Result (30 requests, no errors):

| `...` examples | Without instruction | With "Do NOT use ... as a KB_search query" |
| -------------- | ------------------- | ------------------------------------------ |
| 39             | 5/15 copied         | 3/10 copied                                |
| 55             | 15/15               | **10/10**                                  |
| 71             | 14/16               | **10/10**                                  |

- The instruction made no difference. At 55 and 71 examples every reply sent
  `...`, a single 19-token call with 0 reasoning tokens, directly against the
  system prompt.
- At 39 examples the rate is the same as without it. The 7 replies that
  didn't copy all reasoned (212 to 516 tokens); 4 of them searched with real
  queries and 3 gave the customer the dispute tools, where without the
  instruction 10 of 15 skipped searching. Too few replies to say the
  instruction changed that.
- The instruction sits at the end of the system prompt, about 30k tokens
  before the end of the history. Finding 4 suggests the tail of the context
  steers copying, so the same rule placed right before the agent's turn may
  do better. Not tested.
- Reasoning totals over all sweeps now: 129 of 131 copies used 0 reasoning
  tokens; 163 of 166 non-copies reasoned.

## 2026-10-08: What does the agent reason before a copy?

Only 2 of 131 copies came after any reasoning (117 and 95 tokens), both at
N = 0, where the "`...` working" and "`...` failing" requests are identical:
the 7 real queries set to `...`, nothing added. The scripts kept no reply
text, and the reasoning itself comes back encrypted. Added `SUMMARIES=true`
to `scripts/run-repeats.ts`, which stores the readable reasoning summary
(when the API returns one) in a `reasoning_summary` column, to
`results/dots_summaries/banking_021.csv`. Plan: N = 0 × 20. The original
replies in both captured conversations came back with empty summaries, so
this may return nothing readable.

## 2026-10-09: Does copying still rise with the count when the last result is fixed?

In the `...`-with-real-results runs, which real result ends the history
depends on N (it cycles through the 7), and the swap test showed that ending
on result 7 switches copying off. So that curve mixes two effects. Added
`END=<k>` to `scripts/run-repeats.ts`: for each count it picks the starting
point of the cycle so every history ends on result k. Plan: END=6 (the
rounding-policy result, 15/15 copied at 55 examples) and END=7 (the "off
switch"), N = 4, 8, 16, 32, 40, 48, 56, 64 (11 to 71 examples) × 5 each, to
`results/dots/banking_021_end6.csv` and `_end7.csv`. If copying still rises
with the count at a fixed ending, the count effect is clean; the END=7 curve
shows whether enough repeats overpower the off switch.

Result (80 requests, no errors), copies out of 5:

| `...` examples | Ends on result 6 | Ends on result 7 |
| -------------- | ---------------- | ---------------- |
| 11             | 0                | 0                |
| 15             | 0                | 0                |
| 23             | 1                | 0                |
| 39             | 4                | 0                |
| 47             | 4                | 0                |
| 55             | 5                | 0                |
| 63             | 1                | 0                |
| 71             | 5                | 2                |

- The count effect holds with the ending fixed: on result 6, 0/10 at 15
  examples or fewer, 13/15 from 39 to 55, 5/5 at 71.
- Ending on result 7 switches copying off: 0/35 from 11 to 63 examples, and
  only 2/5 at 71.
- The dip at 63 examples is not caused by result 7. It shows up on every
  ending tried: 1/15 ending on result 7, 4/10 on result 1, 1/5 on result 6,
  6/30 in all, against near-total copying at 55 and 71 on any ending but 7.
  Unexplained. N = 56 is the only count that adds exactly whole cycles of the 7
  searches (8 cycles), but whether that matters isn't tested.
- Finding 5 in the blog attributed the 63 dip to result 7; that was wrong.
- Reasoning split holds: all 14 copies used 0 reasoning tokens; every other
  reply reasoned (73 tokens or more).

## 2026-10-09: Is result 7 special because it was the agent's last search?

Guess from finding 5: result 7 switches copying off because, in the real
conversation, it was the result of the agent's last search before it stopped
searching and wrote to the customer. Searches 5, 6 and 7 were one parallel
batch, followed by that message. Added `SWAP_LAST=true` to
`scripts/run-repeats.ts`, which swaps searches 6 and 7 (calls and results)
inside that batch, so the rounding-policy result becomes the agent's last
real search and the Silver promo result moves one place earlier. The added
searches then cycle in the new order, so with the swap, `END=7` ends on the
rounding-policy result and `END=6` on the Silver promo result; the CSV's
`ends_on` column records which.

Plan: both endings at N = 40, 48, 64 (47, 55, 71 examples) × 5, to
`results/dots/banking_021_swapped_end6.csv` and `_end7.csv`.

| History ends on                           | Guess right (position) | Guess wrong (content) |
| ----------------------------------------- | ---------------------- | --------------------- |
| rounding policy, now the last real search | switched off           | copies                |
| Silver promo, no longer last              | copies                 | switched off          |

Result (30 requests, no errors), copies pooled over 47, 55 and 71 examples:

| History ends on | Normal order            | Searches 6 and 7 swapped        |
| --------------- | ----------------------- | ------------------------------- |
| rounding policy | 14/15 (not last)        | 4/15 (now the last real search) |
| Silver promo    | 2/15 (last real search) | 12/15 (no longer last)          |

- The off switch moved with the position: whichever result was the agent's
  last real search before it wrote to the customer switches copying off. So
  result 7 mattered for where it sat, not what it said. The guess holds.
- The flip is strong but not complete (4/15 and 12/15 against 2/15 and 14/15).
- It fits "continues the sequence": in the real conversation, the agent's last
  search was followed by stopping and writing to the customer, and a history
  that ends on that search gets the same next step. Inside the added loop the
  same result is always followed by another search, so the agent weighs the
  real conversation's next step over the inserted ones.
- Reasoning split holds: all 16 copies used 0 reasoning tokens; the 14 replies
  that moved on all reasoned (100 to 488 tokens) and gave the dispute tools.

## 2026-10-09: Dropped finding 5 from the write-up

The "final search switches copying off" result (fixed-ending and swap runs)
isn't the main point of the post, so it is out of `blog.md`, along with its
takeaway and its two claim tests. The reasoning chart now counts only the
runs the post describes (`...` with real results, `...` with no results, the
instruction run, and both snake_case runs): 124 of 126 copies used 0
reasoning tokens. The CSVs and the `START`, `END` and `SWAP_LAST` options stay
for anyone who wants to rerun it; the results are in this log.

Later the same day: removed the result-ordering runs entirely. Deleted
`results/dots/banking_021_start1.csv`, `_end6.csv`, `_end7.csv`,
`_swapped_end6.csv` and `_swapped_end7.csv`, and the `START`, `END` and
`SWAP_LAST` options from `scripts/run-repeats.ts` (with `startToEndOn`,
`swapLastTwoSearches` and their tests). The numbers above remain the record
of those runs.

## 2026-10-09: Replaying real trajectories with stubbed arguments

The appended-repeats setup is artificial: the repeated calls were never made
by the agent, and it isn't the situation that started this (a context-
management step stubbing the arguments of an agent's own past calls). New
setup, `scripts/run-replay.ts` → `results/replay/banking.csv`:

- 10 real passing tau-banking trajectories (`data/trajectories/`, gpt-6.1-sol
  at xhigh): one per task for banking_047, 048, 049, 052, 055, 056, 057, plus
  a second run of 048, 049 and 057. 37 to 56 tool calls each.
- In each, the points where the agent's next move was a batch of tool calls,
  thinned evenly to 12. The history before the cut holds 0 to 55 calls.
- Three conditions: `intact` (control), `stub_all` (every past call's
  argument values become `...`; results and calls without arguments stay), and
  `keep_3` (the same, but the 3 most recent calls keep their arguments).
- 2 replies each: 720 requests, about 43M input tokens before caching.
- A reply copies when any of its calls has a `...` argument. The CSV records
  the number of stubbed calls in the history, so copying can be read against
  it, and the full text of every call in the reply.

Replay results (732 requests, 7 failed with OpenAI 500 errors), copies out
of replies with something stubbed: intact 0/242, stub_all 103/221 (47%),
keep_3 0/241. Every trajectory copied (2 to 18 of ~22). Copying is common for
lookup-style arguments (user ID 14/17, agent tool calls 34/47, unlocks 21/34)
and rarer for free-text search (32/101). No trend with the number of stubbed
calls: 42% at 1 to 5, 71% at 6 to 10, 31% to 77% after. 57 of 103 copies used
0 reasoning tokens, against 26 of 118 non-copies; 118 of 242 intact replies
also used none, so in real trajectories skipping reasoning is common anyway.

To see what the agent reasons before a copy: added `TURNS` and
`SUMMARIES=true` to `scripts/run-replay.ts` (summaries go to
`results/replay/banking_summaries.csv`). Picked banking_056_a turn 3 under
stub_all, where both earlier replies copied after 152 and 232 reasoning
tokens (three parallel `KB_search("...")` calls each). Plan: 10 replies.

Summary capture (10 requests, no errors): all 10 replies copied `...`, and 6
came with a readable reasoning summary. In every one of those 6, the summary
plans a specific search ("I'll search for terms like 'fee-free period startup
balance waiver'…", "I need to focus on getting hits for '<account> fees
charges'…", "Using specific titles like '<account> monthly maintenance
balance'…"), and the call it then sends is `KB_search("...")`. One summary
counts its past searches ("I might have done too many searches—18 excessive
searches") without noting they are all `...`. So in these replies the
reasoning picks a real query and the call follows the history's pattern
instead. One request, sampled 10 times.

Correction to the summary-capture entry above: 4 of the 6 summaries name a
specific search to run; the other 2 reason about which account to recommend
without naming a query. All 10 replies still sent `KB_search("...")`.

Blog restructured around two experiments: the real-trajectory replay
(experiment 1, with a new chart of copy rate by condition and new claim tests
in `src/claims/replay.test.ts`) and the inserted repeats (experiment 2). The
reasoning chart now pools every run: of 1,032 replies, 76% of copies used 0
reasoning tokens against 34% of non-copies (means 33 and 135 tokens).

Added a `stub_last_3` condition to `scripts/run-replay.ts`, the inverse of
`keep_3`: only the 3 most recent calls are stubbed and older calls keep their
arguments. If it copies often, the most recent calls set the pattern; if it
rarely copies, intact history outweighs a few recent stubs. Same 10
trajectories × 12 points × 2 replies (240 requests), into
`results/replay/banking.csv`. It runs only when listed in `CONDITIONS`.

`stub_last_3` result (240 requests, 2 failed with server errors): 24 of 218
replies copied (11%), against 103 of 219 at the same points under
`stub_all` and 0 of 212 under `keep_3`. It depends on how much intact history
is left: 7/20 (35%) with 0 to 2 intact older calls (early turns, where it is
almost the same as stubbing everything), 7/37 (19%) with 3 to 9, and 10/161
(6%) with 10 or more. As before, lookups copy most (user ID 7/16, agent tool
calls 12/47) and searches least (2/102). 22 of 24 copies used 0 reasoning
tokens, against 45 of 194 non-copies. So the most recent calls matter most:
three intact recent calls prevent copying even with dozens of stubs before
them, while three recent stubs cause some copying that a long intact history
mostly, but not entirely, holds off.

Removed the "Dead ends" section from the blog (the final-turn replay and the
7-example snake_case run), with its two claim tests (`src/claims/early.test.ts`)
and their recordings. Both results stay recorded above in this log.

A live recording of the "71 failed `...` searches" claim test copied on only
1 of 3 replies (the other 2 reasoned and gave the dispute tools), so the
claim "all 5 replies copied" was based on too few replies. 10 more replies at
that point (`SOURCE=failed COUNTS=64 RUNS=10`): 9 copied, 14 of 15 in all. The
blog now says 14 of 15, and the test samples 5 replies and needs at least 3
copies, each with 0 reasoning tokens. Old recording deleted for re-recording.

Pre-publish fixes: the reasoning chart and its numbers now leave out the two
summary-capture runs (picked for replies that reasoned, so biased toward
reasoning copies). Pooled over the rest: 1,250 replies, 212 of 262 copies
(81%) and 333 of 988 non-copies (34%) used 0 reasoning tokens. Experiment 2
alone: 133 of 135 copies used 0 reasoning tokens.

Pre-commit cleanup: removed `prompt_cache_key` (an internal trajectory ID)
from every file in `data/`; the claim tests need re-recording since their
request bodies changed. Deleted what the post no longer uses: the snake_case
style run (`scripts/run-mimicry.ts`, `results/mimicry/`), the
`data/banking_056/` capture, the sandbox (`src/server.ts`,
`src/sandbox.html`), and the code and tests only they used.

## 2026-10-09: Renamed to pattern_following

The experiment was `history_edits`, after how it was run. Renamed to
`pattern_following` (folder and package `@experiments/pattern_following`),
after what it found.
