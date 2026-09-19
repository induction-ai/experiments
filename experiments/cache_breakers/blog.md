# What exactly breaks a prompt cache, and in what order?

Prompt caching is supposed to be simple: send the same prefix again and the
tokens you already paid for come back cheaper. In practice, requests change
in small ways between calls. A tool gets added, the reasoning effort
changes, a routing key goes missing, an earlier message is edited. This
experiment changes exactly one thing at a time on a warm request and measures
how much of the cache survives. The aim is to learn which parts of a request
the cache depends on, and in what order it lays them out.

It covers two APIs:

- **OpenAI Responses with `gpt-5.6-sol`.** Caching is automatic. Because
  the matching rule turned out to change between OpenAI model generations,
  **`gpt-5.5`** is included as a second OpenAI column.
- **Anthropic Messages with `claude-opus-5`.** Caching needs a
  `cache_control` marker, so both ways of adding one are tested: **automatic**
  (one top-level `cache_control`, the closest thing to OpenAI’s implicit
  cache) and **explicit breakpoints** (a marker at the end of every section,
  which is what lets the order show).

**Every result is the median of 5 independent trials,** and within every
condition all 5 agreed (apart from `gpt-5.5`’s occasional random misses,
described below). Every finding also has a recorded test that reproduces it.

## Side by side

<!-- report:compare -->

Read the thread rows first: they’re what happens in a real conversation.
Everything below them edits a single request whose history was never sent
turn by turn, the worst case for any cache that reuses earlier requests.

## Method

Every trial builds a fresh request from seeded filler text (no real prompts
or data), in sections of known size:

| Section       | OpenAI Responses            | Anthropic Messages       |
| ------------- | --------------------------- | ------------------------ |
| tools         | 8 function tools in `tools` | 8 tools in `tools`       |
| system prompt | `instructions`              | `system`                 |
| early history | user + assistant message    | user + assistant message |
| late history  | user + assistant message    | user + assistant message |
| final message | one short user message      | one short user message   |

Each section starts with a random per-trial nonce, so no two trials can share
a prefix whichever section the API renders first. On OpenAI each trial also
sets its own `prompt_cache_key`, which routes requests to the same cache.

A trial sends the base request until it reports cached tokens, then sends it
once more with exactly one change and records how many tokens were read from
cache (`cached_tokens` on OpenAI, `cache_read_input_tokens` on Anthropic),
next to how many were written.

Three kinds of change are tested:

- **Probes** edit the start or the end of one section. Where the cached count
  lands after each probe shows where that section sits in the cached prompt,
  which recovers the order.
- **Parameter changes** vary one request field: model, reasoning effort
  (every ordered pair of levels), thinking, tool definitions, `tool_choice`,
  output format, routing and account fields, cache settings, and so on.
- **A tool loop.** One live call makes the model reason and then call a tool.
  The next request replays its output (OpenAI: a `reasoning` item and a
  `function_call`; Anthropic: a `thinking` block with its signature and a
  `tool_use`) followed by a tool result. That replay is the base.

**Filler.** OpenAI gets random common words. Claude Opus 5’s safety
classifiers refused that as “bio”, and a grammar of plain sentences as
“cyber”, in up to 11 of 12 requests. A refused request never reads from
cache, so it can’t be a trial. Anthropic therefore gets seeded slices of a
public-domain novel (_Pride and Prejudice_, chapters 1–20, in `data/`),
which was accepted every time.

**How much evidence.** Every condition on both APIs ran **5 independent
trials**, and in every condition all 5 landed on the same outcome. On top
of that, every finding has a recorded claim test that reproduces it (see
“Verify it yourself”). Code: `scripts/run-static.ts`,
`scripts/run-tool-loop.ts`, `scripts/run-thread.ts` and
`scripts/run-minimum.ts`, writing `results/<scenario>/<adapter>.csv`.

## OpenAI Responses (`gpt-5.6-sol`)

Every change falls into one of five outcomes. The list below is generated
from the CSVs, with the share of the warm prompt that was still cached:

<!-- report:tiers -->

### 1. A mid-thread edit falls back to the previous turn

In a real conversation every turn is sent, so every earlier request leaves
a reusable point behind. `scripts/run-thread.ts` → `results/thread/`
builds a 6-turn thread one request at a time, with ~500-token assistant
replies, then changes it in the middle:

<!-- report:thread -->

Editing user message 4, branching the thread at turn 4 with a different
message, or cutting it after reply 4 all keep **exactly** everything up to
the end of the previous turn (the request that ended with user message 3,
or 4 for the cut). The pause before the edit made no difference. So the
cache does hold in the middle of a thread. Verified by
`src/claims/thread.test.ts`.

It holds at those points and nowhere else. Reuse doesn’t continue into the
unchanged ~500-token assistant reply that follows the previous turn, which
a longest-prefix match would include. It also doesn’t stop at a 128-token
boundary, the granularity OpenAI documented for earlier models. The
reusable points are:

1. **The exact end of every earlier request**, as long as the new request
   contains that whole request unchanged. In a thread, that’s every earlier
   turn.
2. **The end of a header block** made of the tools, the instructions and a
   set of request parameters (next section). An edit anywhere in the tools
   or the instructions loses everything, so the cache can’t reveal which of
   the two comes first.

**The edge case: a history that was never sent turn by turn.** The
single-request probes send a prebuilt history in one go, which a client
does when it assembles a conversation elsewhere or starts from a
transcript. Then no earlier request ended inside the history. Editing any
history message, even appending one word to the 8-token final message, fell
back to the header (~3050 of ~6150 tokens) and re-wrote the whole history.
Sending the previous turn first raised that to ~5380
(`prev_turn_then_final_edit`). A “sibling” request that shared the early
history and then diverged added nothing (`sibling_then_late_edit`), because
the shared part wasn’t the end of any request.

<!-- report:layout -->

**Is this just a minimum-size effect?** No. The same header probes were
repeated with 300, 600 and 4000 words per section. At 4000, about 8000
unchanged tokens come before an edit at the end of the system prompt, and
it still kept 0 in 5 of 5 trials. There is a minimum, and it shows at the
small end. A ~690-token header (300 words) isn’t reusable on its own, while
a ~1233-token one (600 words) is, which fits OpenAI’s documented 1024. Every
other result here uses ~3060-token headers, well above it.

<!-- report:sizes -->

**The minimum is exactly 1024 tokens, and it applies to each reusable point
separately.** `scripts/run-minimum.ts` → `results/minimum/openai_responses.csv` sweeps prompt
size in fine steps around it. A whole prompt is cached only when its
cacheable part (the input minus the final 3 tokens, which are never cached)
reaches 1024: 1022 missed and 1027 hit. A header is reusable only from 1024
tokens: the smallest one reused was exactly 1024, and one of about 1020
wasn’t, even though the full prompt around it was over 4000 tokens. Hits and
misses never overlapped across 90 trials.

<!-- report:minimum -->

Verified by `src/claims/checkpoints.test.ts` and `src/claims/minimum.test.ts`.

Ordinary conversation growth fits this pattern. Appending a turn keeps
everything (`append_turn`, 100%), because the new request starts with the
entire previous one.

### 2. What resets the cache to zero, and what doesn’t

<!-- report:compare-static:openai_responses+openai_responses_gpt-5.5 -->

**Everything lost (0 cached tokens, 5/5 trials):**

- **System prompt:** any edit to `instructions`, whether to its first
  character or by appending one word to its end.
- **Model:** switching to `gpt-5.6-luna`.
- **Reasoning effort:** any change of `reasoning.effort`, between any two of
  the six levels the model accepts (`none`, `low`, `medium`, `high`,
  `xhigh`, `max`; all 30 ordered pairs). See the next section.
- **Tools:** adding, removing or reordering a tool; removing all tools.
- **Header parameters:** `parallel_tool_calls: false` (adds ~80 input
  tokens, rendered into the header), a `text.format` JSON schema, and
  `text.verbosity`.
- **Routing:** a different or missing `prompt_cache_key`, and
  `service_tier` `flex` or `priority`. These don’t change the prompt; they
  send the request to a different cache.

**No effect (100% kept):**

- Moving the system prompt from `instructions` into a leading `developer` or
  `system` message. All three render identically.
- Appending a `developer` message mid-conversation, after the final user
  message.
- `strict: false` on tools, and reordering keys inside a tool’s JSON schema.
  The schema is normalised before rendering.
- A string message vs the same text as `[{type: "input_text"}]`.
- `max_output_tokens`, `reasoning.summary`,
  `include: ["reasoning.encrypted_content"]`, `store`, `metadata`,
  `safety_identifier`, `truncation`, and `prompt_cache_retention: "24h"`.

**Rejected:** `temperature` and `top_p` return “Unsupported parameter” on
this model, so they can’t break anything.

Verified by `src/claims/resets.test.ts` and `src/claims/no-effect.test.ts`.

### 3. Reasoning effort: each level has its own cache

Every one of the 30 ordered pairs of effort levels drops the cached count to
0, and `input_tokens` doesn’t change. Effort isn’t extra text in the prompt;
like the model and `service_tier`, it selects a separate cache. Two follow-up
variants confirm this:

- **Switching back works.** Warming at `low`, sending one request at
  `medium`, then returning to `low` kept 100% (`effort_switch_back`). The
  `low` cache survives a detour, so alternating between two levels costs one
  cold write per level, not one per switch.
- **The default is `medium`.** Omitting `reasoning` kept 100% only when the
  cache was warmed at `medium`, and 0 after every other level
  (`effort_<level>_omitted`). Sending the default explicitly is the same as
  omitting it.

The other reasoning fields are harmless: `reasoning.summary` and
`include: ["reasoning.encrypted_content"]` kept 100%.

Verified by `src/claims/effort.test.ts`, which runs all 30 pairs.

### 4. `tool_choice` costs a fixed tail, not the cache

Setting `tool_choice` to `required`, `none` or a named function kept
98–99% of the prompt. Unlike every other change, it left `input_tokens`
unchanged and wrote nothing to cache. The cached count simply dropped by a
constant for each choice in every trial: 72 tokens for `none`, 119 for
`required`, 128–129 for a named function. A fixed-size tail at the very end
of the prompt is swapped and billed at the uncached rate. Nothing is
invalidated, so varying `tool_choice` from turn to turn is cheap. Verified by
`src/claims/tool-choice.test.ts`.

### 5. Images and history edits

Adding an image to the final message behaves like any other edit to it
(`image_in_final`): the history falls back to the last reusable point. There
is nothing image-specific about it. Verified by
`src/claims/checkpoints.test.ts`.

### 6. Tool loops: reasoning items are part of the prompt, ids aren’t

<!-- report:tool_loop -->

- **Everything kept:** replaying the output items as returned; stripping
  their `id`s; passing the reasoning item, or both output items, as an
  `item_reference`; and sending `previous_response_id` plus only the tool
  result. The server rebuilds exactly the same prompt in each case, with the
  same `input_tokens`.
- **Starting a new user turn doesn’t strip earlier reasoning.** Appending the
  assistant’s reply and a new user message after the tool result kept 100%,
  and the input grew only by the appended turn.
- **Dropping the reasoning item is rejected** while the `function_call`
  still carries its `id`:
  `Item 'fc_…' of type 'function_call' was provided without its required 'reasoning' item`. With the ids stripped as well, it
  is accepted. The input shrinks by 106–221 tokens, which is the rendered
  reasoning, and the cache falls back to the end of the previous request.
- **Editing the tool result** also falls back to the previous request’s end,
  re-writing ~400 tokens: the unchanged reasoning item and `function_call`
  as well as the result.
- Changing `reasoning.effort` mid-loop loses everything, as it does anywhere
  else.

Verified by `src/claims/tool-loop.test.ts`.

### 7. `gpt-5.5` reuses fixed points, not whole messages

OpenAI’s caching documentation describes matching the longest prefix in
128-token increments, and that is how older models behave. A two-trial pilot
across models (`scripts/run-models.ts` → `results/models/`) showed every
cached count on `gpt-4o`, `gpt-4.1` and `gpt-5` as a multiple of 128, and on
`gpt-5.4` and `gpt-5.5` as a multiple of 512, with reuse reaching into the
edited message. `gpt-5.6-sol` is the outlier, and so is its sibling
`gpt-5.6-luna`, which in the same pilot (all 16 sweep points, 2 trials each)
matched only whole messages too: the change came with the 5.6 generation. To pin one older rule down,
`gpt-5.5` ran the full variant set at n=5, plus a sweep that replaces a
single word at 8 points inside a long message:

<!-- report:sweep:openai_responses_gpt-5.5 -->

On `gpt-5.5` reuse always stopped at a fixed point: every nonzero count
was 512 plus a multiple of 1024 (1536, 2560, 3584, 4608, 5632), whether or
not that point fell on a message boundary. What decides _which_ point is
reused is less clear:

- **Single request:** an edit kept the last point before it. An edit late in
  the instructions kept 2560 tokens, partway through them (`gpt-5.6-sol`
  never keeps part of the instructions); an edit at the end of the third
  history message kept 4608.
- **Real thread** (`results/thread/openai_responses_gpt-5.5.csv`). The thread
  itself behaved as expected: each turn read the previous request’s end,
  rounded down to a point (1536, 2560, 2560, 3584). But appending a word to
  user message 4, or replacing it, then cached only **1536 tokens** in 14 of
  15 trials, where about 3440 tokens were unchanged. With these message
  lengths that point fell early in the conversation, inside the first reply,
  but it’s a token position, not a message boundary. The 2560 point, which lies before the
  edit and which turns 3 and 4 had both read, was reused only once. Dropping
  everything after reply 4 cached up to the 3584 point, the last one before
  the cut, which is more than `gpt-5.6-sol` keeps. Appending a word to reply 4
  cached up to the same 3584 point in 3 of 4 trials that didn’t miss, partway
  into the changed reply itself.

So `gpt-5.5` isn’t a simple “longest shared prefix, rounded down to a
block” either: an intact block that earlier turns had read was usually
skipped after a mid-thread edit. We couldn’t pin down the rule from these
probes.

- Everything that reset `gpt-5.6-sol` to zero also resets `gpt-5.5`: tools,
  model, effort, output format, verbosity and routing fields. The default
  effort is also `medium`, and `tool_choice` also costs only a fixed tail
  (128 tokens). `gpt-5.5` rejects the `max` effort level.
- **`gpt-5.5` sometimes misses the cache entirely.** 9 of 195 trials that
  should have reused tokens read 0 (4.6%), at random. That never happened on
  `gpt-5.6-sol` or on Anthropic (0 of 415).

<!-- report:tiers:openai_responses_gpt-5.5 -->

Verified by `src/claims/gpt-5.5.test.ts`.

## Anthropic Messages (`claude-opus-5`)

### 1. Automatic caching: back to the previous turn, and nowhere else

With one top-level `cache_control`, the API puts a single breakpoint on the
last block of each request. In a real thread that means every turn leaves
its end behind, and a mid-thread change behaves exactly as on OpenAI:
editing user message 4, branching at turn 4 or cutting after reply 4 keeps
exactly everything up to the previous turn’s end, and nothing of the reply
after it. Explicit breakpoints behave the same in a thread, with markers on
the tools, the system prompt and each request’s last message: 20 of 20
trials landed exactly on the previous turn’s end. Appending a word to reply 4
instead behaves the same way one turn later: all three cache exactly through
user message 4 and re-bill from reply 4 on (15 of 15 trials). Verified by `src/claims/thread.test.ts`.

<!-- report:thread:anthropic_auto -->

Because those request ends are the only reusable points, the edge case is
harsher than on OpenAI. With a history that was never sent turn by turn,
any edit anywhere reused **nothing**: the tools, the system prompt, any
history message, even one word appended to the 8-token final message.
There is no header checkpoint to fall back to. Sending the previous turn
first recovered ~10.5k of ~11.9k tokens (`prev_turn_then_final_edit`).

<!-- report:tiers:anthropic_auto -->

Verified by `src/claims/anthropic-auto.test.ts`.

### 2. With breakpoints, the order is tools → system → messages

With a breakpoint at the end of every section, each probe keeps exactly the
sections before it. A tools edit keeps 0; a system prompt edit keeps the
tools; an early-history edit keeps tools and system; a late-history edit
keeps everything through the early exchange. That is Anthropic’s documented
order, recovered from the data.

<!-- report:layout:anthropic_breakpoints -->

Breakpoints also show where each parameter sits. `tool_choice` `any` or a
named tool keeps tools and system and loses only the messages, as
documented. A JSON-schema output format keeps only the tools, so it’s
rendered with or before the system prompt. Changing the model, turning
thinking off, `inference_geo`, or any effort change reuses nothing even
with a breakpoint on the tools: on Opus 5 these sit ahead of everything.

<!-- report:static:anthropic_breakpoints -->

Verified by `src/claims/anthropic-breakpoints.test.ts`.

### 3. Reasoning effort, thinking and a beta header

- **Every effort change resets the cache to zero,** across all 20 ordered
  pairs of the five levels (`low` to `max`).
- **The default is `high`.** Omitting `output_config.effort` kept
  everything only after `high`, and nothing after any other level.
- **A level keeps its own cache.** Going low → medium → low still hit the
  original `low` cache.
- **Thinking:** turning it off resets to zero; sending
  `thinking: {type: "adaptive"}` explicitly or asking for summarized
  thinking has no effect.
- **A beta header alone resets the cache.** The per-message effort feature
  (`mid-conversation-output-config-2026-07-01`) is documented as preserving
  the cache, but using it reset to zero. Sending just its `anthropic-beta`
  header, with no other change, did the same, so the header is what
  changes the cache key, not the effort message.
- `temperature` and `top_p` are rejected on this model (“deprecated”).

Verified by `src/claims/anthropic-effort.test.ts` and
`src/claims/anthropic-auto.test.ts`.

### 4. What else resets, and what doesn’t (automatic caching)

**Resets to zero:** adding, removing or reordering a tool; switching to
`claude-sonnet-5`; `tool_choice` `any` or a named tool; an image in the
final message; a JSON-schema output format; `inference_geo: "us"`.

**No effect:** `tool_choice: none`, `disable_parallel_tool_use`, a
mid-conversation `{role: "system"}` message, `system` as blocks instead of a
string, `strict` on tools, key order inside a tool schema, message content
as blocks, `max_tokens`, `stop_sequences`, `metadata.user_id`,
`service_tier`, a 1-hour TTL instead of 5 minutes, and replacing automatic
caching with an explicit breakpoint on the same block.

### 5. Tool loops: thinking blocks

<!-- report:tool_loop:anthropic_auto -->

- Replaying the assistant turn verbatim, or adding a new user turn after the
  tool result, keeps everything. The earlier thinking block isn’t stripped.
- **Dropping the thinking block is accepted**, unlike OpenAI’s reasoning
  item. It costs a fall-back to exactly the previous request’s end, the
  same point an edited tool result falls back to.
- An edited thinking signature is rejected (400).
- An effort change mid-loop resets to zero.

Verified by `src/claims/anthropic-tool-loop.test.ts`.

## Takeaways

For `gpt-5.6-sol` on the Responses API:

- **Order:** the model and routing fields pick the cache. Inside it comes one
  header block: tools, instructions, reasoning effort, verbosity, output
  schema and `parallel_tool_calls`. Then the messages, in order. Last comes a
  small `tool_choice` tail. Inside the header nothing can be ordered, because
  any change there discards the whole block.
- **Pin everything that lives in the header** for a whole conversation:
  system prompt, model, effort, tool set and order, verbosity, output
  format, `parallel_tool_calls`, `service_tier` and `prompt_cache_key`. Any
  change there re-bills the entire prompt. If you must vary effort, each
  level keeps its own cache, so returning to an earlier level still hits.
- **An edit mid-thread costs the turns after the previous one.** Editing,
  branching or cutting a thread keeps everything up to the end of the last
  earlier turn it still contains, and re-bills the rest. It doesn’t keep the
  unchanged part of the turn being edited. A history that was never sent
  turn by turn has no such points, so an edit there falls back to the
  header.
- **Replay reasoning items exactly.** Full items, references and
  `previous_response_id` are all equivalent. Dropping a reasoning item costs
  a re-write from that point on.
- **Harmless to vary:** `tool_choice` (a small fixed tail),
  `max_output_tokens`, `store`, `metadata`, `safety_identifier`, `include`,
  the reasoning summary, and where the system prompt lives.

For `claude-opus-5` on the Messages API:

- **With automatic caching, only earlier turns’ ends are reusable.** In a
  thread, an edit falls back to the previous turn, as on OpenAI. A prompt
  whose earlier parts were never sent as requests has no fallback at all,
  so any edit costs the whole prompt. If parts of the prompt change at
  different rates, add explicit breakpoints: then an edit only costs the
  sections after the nearest one.
- **Order:** model, effort, thinking mode, `inference_geo` and beta headers
  pick the cache. Then tools, then the system prompt (with the output
  format), then messages.
- **Pin** the model, effort, thinking mode, tool set, output format,
  `inference_geo` and beta headers for a whole conversation. Varying
  `tool_choice` costs the messages; `none` is free.
- **Replay thinking blocks exactly.** Dropping one is allowed but re-bills
  everything after the previous turn.

## Verify it yourself

Every claim above has a test in `src/claims/` that reproduces it, named after
the claim. The tests run the same procedure as the scripts and assert the
outcome stated here. Their recorded API traffic is committed under
`test/__recordings__/claims/`.

```sh
pnpm install
pnpm --filter @experiments/cache_breakers test              # replay the recorded traffic, no keys needed
RECORD=true pnpm --filter @experiments/cache_breakers test  # re-run every claim live
```

The live run needs `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. It uses fresh
nonces, so it can’t pass by hitting a cache left by the recording. If either
provider changes how caching works, the test for the claim that no longer
holds will fail. The CSVs give the consistency behind each claim; the tests
show that each claim reproduces.

## Scope

Two APIs, tested on 2026-09-18: OpenAI Responses with `gpt-5.6-sol` (and
`gpt-5.5` for the single-request variants), and Anthropic Messages with
`claude-opus-5`. Gemini and OpenAI Chat Completions are out of scope. The
matching rule differs between OpenAI model generations: 128-token blocks on
`gpt-4o`, `gpt-4.1` and `gpt-5` in a small pilot, 2048-token points on
`gpt-5.5`, whole messages on `gpt-5.6-sol` and `gpt-5.6-luna`. So check the model you use,
and don’t assume these results carry over. Results describe the providers’
behaviour on that date, and the live tests are the way to check whether it
still holds.
