# Agent see, agent do

When an AI agent sees a pattern in its messages and tool calls, it repeats the behavior, even if it is directly instructed not to. A few stubbed calls are enough to trigger the mimicking. We also noticed models reason much less often when entering this pattern-following loop, and observed reasoning doesn't mention the pattern at all.

A potential context reduction strategy is to replace all old tool call parameters with some short placeholder like `...`. When we tried this, a long coding agent session errored on a tool call: `Agent({prompt: "..."})`. We looked at the trajectory and realized all previous `Agent()` tool call args were stubbed with `...`. Even though the tool description asks for a subagent prompt, the model followed its "own" previous behavior over prompting. We wanted to learn more about this behavior and are able to reproduce it, so we made an experiment.

## Experiment 1: Stubbing real trajectories

We took 10 passing
`gpt-6.1-sol` runs of [tau-banking](https://github.com/sierra-research/tau2-bench),
a customer-support benchmark where an agent helps a bank customer with a
knowledge base (`KB_search`) and account tools, at reasoning effort xhigh. Each
run made between 37 and 56 tool calls. We picked 12 turns in each run where the agent
was about to call a tool, took a snapshot there, and replayed it four ways:

```text
as recorded   get_credit_card_accounts_by_user({"user_id":"abc123"})
stub all      get_credit_card_accounts_by_user({"user_id":"..."})      ← every past call
keep last 3   every past call stubbed except the 3 most recent
stub last 3   only the 3 most recent calls stubbed, older ones as recorded
```

Tool results are always kept. We say a response **copies** if any argument of its next
call is `...`. Each request was sent twice.

<!-- report:replay -->

- **Stubbing all of the agent's own tool calls breaks half its next calls.** 103
  of 221 replies wrote `...` into a call, and it happened in all 10
  trajectories. There were obviously no stubbed responses if we did not stub calls in the payload.
- **Recent calls matter most.** Even with up to ~50 calls stubbed in the context, 0 of 212 payloads copied the behavior if the last 3 calls didn't stub. Stubbing only the 3 most recent calls, with everything older intact, broke 24 of 218 calls (11%), and 6% once the context held 10 or more normal calls.
- **It starts almost immediately.** With just 1 to 5 stubbed calls in the history, 10
  of 24 replies already copied, and more stubs didn't make it more consistent.
- **Lookups break more than searches.** For arguments like an ID or a tool name, the LLM
  usually writes the stub. For more prose-like search, it more often writes a real
  query:

| Next call                    | Copied       |
| ---------------------------- | ------------ |
| look up accounts by user ID  | 14/17 (82%)  |
| call a hidden tool by name   | 34/47 (72%)  |
| unlock a hidden tool by name | 21/34 (62%)  |
| knowledge-base search query  | 32/101 (32%) |

**Reasoning looks normal, then it writes the stub?!** Inspecting reasoning that preceded a stubbed KB_search, we see:

```text
reasoning:  "I need to focus on getting hits for '<account> fees charges'
             to find detailed documents…"
call:       KB_search({"query":"..."})
```

No mention of the stub in reasoning, but the agent still reproduces.

We also see a drop in reasoning preceding a stubbed call: 62% of replies that wrote a stub used zero reasoning tokens, against 39% of normal responses.

## Experiment 2: Controlled repeats

We took a trajectory snapshot from a passing run of [tau-banking](https://github.com/sierra-research/tau2-bench). This is a
customer-support benchmark where an agent uses a knowledge base (via the `KB_search` tool) to help a bank customer. The run used `gpt-6.1-sol` at reasoning
effort xhigh. We cut the history right before the agent's last search, stubbed
its earlier `KB_search` queries, appended N more searches in the same style, and replayed
the request 5 to 16 times per N.

The original snapshot includes 7 KB_searches before the cut. In every experiment trial, all 7 tool calls get the stub, and the N
added searches repeat them in order. We added variants for a "failing" version, in which every added KB_search call returns "No results
found." (the 7 real searches keep their real results). This was an attempt to discourage from stubbing. One more variant we tried was a snake_case stub, to see if a more subtle placeholder has any effect.

Here is one of the agent's real searches, and how each version of the
experiment rewrites it:

```text
original     KB_search({"query":"rewards points rounding whole number truncate fractional points"})
             → 1. Credit Card Rewards Points Rounding Policy …

stubbed      KB_search({"query":"..."})
             → 1. Credit Card Rewards Points Rounding Policy …    (real result kept)

stubbed,     KB_search({"query":"..."})
failing      → No results found.

snake_case   KB_search({"query":"rewards_points_rounding_whole_number_truncate_fractional_points"})
             → 1. Credit Card Rewards Points Rounding Policy …
```

This time, a response **copies** if its next search is written with `...` or snake_case.

<!-- report:copy-curve -->

- **Repeats begin early, then become consistent.** In just a handful of gpt-6.1-sol runs, we see the `...` mimicking begins sparsely at only 7 previous stubs. Then depending on the variant, it becomes more and more consistent until it's near-certain to mimic the stub.

- **Once they mimic, models stop reasoning.** Even though the model reasoning effort was set to xhigh, 133 of the 135 replies that
  copied stubs used zero reasoning tokens. Usage from this example shows 19 output tokens, none from reasoning.

```text
… 55 searches, each answered by a real policy result …
KB_search({"query":"..."})  →  1. Credit Card Rewards Points Rounding Policy …

reply:  KB_search({"query":"..."})       reasoning tokens: 0   output tokens: 19
```

- **Failure doesn't stop it.** We tried changing results to stubbed searches with "No results found", to nudge the model that a stubbed query will not give good results. Despite this, at 71 examples 14 of 15 replies sent `...`
  again. This also favors pattern repetitions over context length as the main cause. Real KB_search tool results produce a ~3.5k-token policy document, so going from 7 to 71 examples balloons the request 31k -> 256k tokens. In this variant, each result is just 3 words, so the same 71 examples come to 33k tokens instead of 256k. The agent still copies reliably:

```text
… 62 more searches like these …
KB_search({"query":"..."})  →  No results found.
KB_search({"query":"..."})  →  No results found.

reply:  KB_search({"query":"..."})       reasoning tokens: 0   output tokens: 19
```

- **An explicit rule doesn't stop it.** More interestingly, explicitly adding "Do NOT use ... as a KB_search query" to the end of the system prompt had seemingly no effect on mimicking rate.

| `...` searches in history | Without "Do NOT..." | With "Do NOT..." |
| ------------------------- | ------------------- | ---------------- |
| 39                        | 5/15 copied         | 3/10             |
| 55                        | 15/15               | **10/10**        |
| 71                        | 14/16               | **10/10**        |

- **It continues the sequence, not a style.** Is the agent picking up a habit, like "write queries in snake_case", or
  continuing the exact sequence of calls in front of it? We tested both with
  snake_case queries.

**With a loop.** The history holds the agent's own 7 searches, repeated in
the same order over and over. Later copies sent the next search query verbatim in a loop:

```text
history: the agent's 7 searches, over and over (55 in all)
  1  cash_back_rewards_calculation_errors_business_bronze_…
  2  business_bronze_rewards_card_cash_back_earn_rate_…
  …
  7  business_bronze_rewards_card_promotion_double_cash_back_new_customer
  1  cash_back_rewards_calculation_errors_business_bronze_…
  …
  5  internal_filing_cash_back_dispute_cash_back_disputes_rewards_tools
  6  rewards_points_rounding_whole_number_truncate_fractional_points

reply:
  7  business_bronze_rewards_card_promotion_double_cash_back_new_customer   ← next in the loop
```

**Without a loop.** We tried adding KB_searches from other trajectories to add variance. Here, the pattern is only snake_case, not the full query. In these cases, we saw a lower rate of copying snake_case:

```text
history: 55 different searches from other conversations
  …
  bronze_rewards_card_earn_1_0_purchases
  close_credit_card_account_closure_request_green_rewards_card_multiple_cards
  credit_card_consultant_travel_software_subscriptions_adobe_project_management_…

most replies: a normal query
  Submitting a Cash Back Dispute submit_cash_back_dispute_0589
a few replies: snake_case
  cash_back_dispute_submit_rewards_review_partial_refunds_…    ← this customer's problem
  pending_credit_card_replacement_cancel_order_user_action     ← another customer's
```

Across the same history lengths (7 to 71 searches), only 7 of 40 replies
(18%) wrote a snake_case query, against 18 of 40 (45%) that continued the
loop. At 47+ searches in the context, it's 33% vs 93%. This still matters, but is much less consistent than a verbatim repeated pattern.

## Copies come with less reasoning

<!-- report:reasoning -->

Across every run in both experiments (1,250 replies), 81% of the replies that
copied a stub used no reasoning tokens, against 34% of the replies that
didn't. On average, copies reasoned for 25 tokens and non-copies for 123.
These numbers leave out the two runs we picked to capture reasoning
summaries, since those were chosen for replies that reasoned.
Copying tends to skip reasoning, but not always: as the summaries above show,
the agent can reason about the right call and still write the stub.

## Takeaways

- **Repeated tool calls can be hazardous.** Imagine a failed tool call, like a rate limited web search. If the model naturally retries a few times, the agent is at risk of entering a long doom loop. To guard against this, make sure to check for repeated calls in your agent.
- **Reasoning effort and prompted rules are overpowered by patterns.** Models are more influenced by their own previous behavior than system prompts.

## Limits

One model (`gpt-6.1-sol`) and one benchmark. Experiment 1 covers 10 real
trajectories, 2 replies per point; experiment 2 uses one conversation with
inserted repeats, 5 to 16 replies per count. In experiment 2, the ends of each
curve are clear but the middle isn't pinned down, and one count stands out
unexplained: with real results, copying dropped to 1 of 15 replies at 63
searches, between near-total copying at 55 and 71. The reasoning example comes
from one point, sampled 10 times.

## Verify it yourself

The key claims have tests in `src/claims/`, with recorded API traffic in
`test/__recordings__/`; the other numbers come from the CSVs in `results/`. The runs behind the numbers are `scripts/run-replay.ts`
(experiment 1) and `scripts/run-repeats.ts` (experiment 2).

```sh
pnpm --filter @experiments/pattern_following test              # replay, no keys needed
RECORD=true pnpm --filter @experiments/pattern_following test  # re-run live
```
