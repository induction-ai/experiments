# experiments

pnpm monorepo for TypeScript experiments. Each experiment is its own workspace under `experiments/`.

## Experiments

| Experiment       | Question                                                                                          | Read                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache_breakers` | What exactly breaks a prompt cache on OpenAI Responses and Anthropic Messages, and in what order? | [report](experiments/cache_breakers/report.html) · [write-up](experiments/cache_breakers/blog.md) · [log](experiments/cache_breakers/log.md) |

Each report is generated from the experiment’s CSVs, and every claim in it has a recorded test that reproduces it (`pnpm --filter @experiments/<name> test`).

## This repo is public

Everything committed here is published. No proprietary code, prompts, customer data, credentials or account identifiers. Use synthetic or public data, and check recordings and results before committing. See `.claude/skills/new-experiment/SKILL.md` for the full rules.

## Setup

```sh
nvm use            # Node 24 (see .nvmrc)
pnpm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
```

## Root scripts

```sh
pnpm lint          # prettier + eslint across the whole repo
pnpm format        # auto-fix with eslint then prettier
pnpm typecheck     # tsc --noEmit in each workspace
pnpm build         # build each workspace
pnpm test          # test each workspace
```

The `-r` scripts (`typecheck`, `build`, `test`) delegate to each workspace's own script, so a workspace only participates if it defines that script in its `package.json`.

## Creating a new experiment

```sh
mkdir experiments/my-thing
cd experiments/my-thing
pnpm init
```

Then set up the three files below.

### `experiments/my-thing/package.json`

```json
{
  "name": "@experiments/my-thing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

### `experiments/my-thing/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

Extending `../../tsconfig.base.json` picks up Node 24 / ES2024 / NodeNext, `strict`, `noUncheckedIndexedAccess`, and `isolatedModules`. Override or add anything experiment-specific in the workspace tsconfig.

### `experiments/my-thing/src/index.ts`

Write code here. Run it with `pnpm --filter @experiments/my-thing dev`.

### Experiment outputs

The code is the _means_; these are the _output_. Every experiment has, alongside `src/`:

- **`blog.md`** — the final deliverable. A post explaining what the experiment does, how it works, and what was found.
- **`log.md`** — running log of **what you tried and what you found**. Chronological. Append as you go, not at the end. Dead-ends count.
- **`results/*.csv`** — running results. One row per trial/run.
- **`scripts/`** — for every CSV in `results/`, a script here that produces it. Running it with `RUNS=N` appends N more trials per condition (`FRESH=true` starts over), so certainty grows with each run. CSVs are never hand-written.

Scaffold all four when you create the experiment. Update `log.md` and append to CSVs as you go; refine `blog.md` throughout, drawing from both.

## Using API keys

Shared code lives at `packages/shared` (`@experiments/shared`). The repo-root `.env` is loaded automatically on import.

```sh
pnpm --filter @experiments/my-thing add '@experiments/shared@workspace:*'
```

Two types:

- **`Service`** — vendor that issues the key: `"openai" | "anthropic" | "gemini"`.
- **`Provider`** — specific API surface you call: `"openai_completions" | "openai_responses" | "anthropic_messages" | "gemini_generation"`. Each provider is owned by exactly one service.

```ts
import {
  getApiKey,
  getClient,
  getModel,
  type Provider,
  type Service,
} from "@experiments/shared";
import { generateText } from "ai";

// Raw key by service
const key = getApiKey("gemini");

// One-shot: pick a provider + model, get a LanguageModel
const { text } = await generateText({
  model: getModel("gemini_generation", "gemini-2.5-flash"),
  prompt: "hi",
});

// Or grab the factory to reuse across model names
const gemini = getClient("gemini_generation");
gemini("gemini-2.5-flash");
gemini("gemini-2.5-pro");
```

All three throw with a clear message if the required env var is missing.

## Testing with HTTP recording

`@experiments/test` wraps [Polly.js](https://github.com/Netflix/pollyjs) to record LLM API responses once, then replay them on every subsequent run — fast, deterministic, no API spend.

Add it to an experiment:

```sh
pnpm --filter @experiments/my-thing add -D '@experiments/test@workspace:*'
```

Import `it` / `describe` / `expect` (and the other vitest helpers) from `@experiments/test` instead of `vitest`. Every `it` body is automatically wrapped in recording/replay; `.only` / `.skip` / `.todo` / `.concurrent` / `.each` still work.

```ts
import { getModel } from "@experiments/shared";
import { describe, expect, it } from "@experiments/test";
import { generateText } from "ai";

describe("gemini", () => {
  it("returns pong", async () => {
    const { text } = await generateText({
      model: getModel("gemini_generation", "gemini-2.5-flash"),
      prompt: "Reply with exactly the word pong.",
    });
    expect(text.toLowerCase()).toContain("pong");
  });
});
```

Tests that don't make HTTP calls pay no disk cost — Polly only writes when a request actually happens. If you need manual control (different modes per call, mid-test toggles), `recordHttp` is still exported for explicit use.

A minimal `vitest.config.ts` in the experiment:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
```

Running:

```sh
RECORD=true pnpm --filter @experiments/my-thing test   # wipe & re-record every file it runs
RECORD=new  pnpm --filter @experiments/my-thing test   # replay known bodies, record new ones
pnpm --filter @experiments/my-thing test               # replay-only (default)
pnpm test                                              # all workspaces, from root
```

- `RECORD=true` deletes the test file's entire `__recordings__/<test-file>/` dir on the first test in it, then records fresh.
- `RECORD=new` replays when a request's body matches an existing recording and hits the real API for anything new, appending to the HAR. Good for adding trials without re-spending tokens on what's already recorded.
- Default replay errors if it sees a request whose body isn't in the HAR — no accidental silent replay of the wrong entry.

All three modes match requests by method + URL + body + order, so identical bodies still produce distinct recordings in order (important for pair-of-call patterns where the 1st and 2nd calls share a body but have different responses).

Recordings land in `<package-root>/test/__recordings__/<test-file>/<sanitized-test-name>/recording.har`, with API-key headers (`authorization`, `x-api-key`, `x-goog-api-key`, `api-key`) masked before persistence. Commit them.

Caveats: `recordHttp` relies on `expect.getState()`, so it must run inside a vitest test, and tests that use it should not be marked `.concurrent` (Polly patches global fetch per file).

## Adding a dependency

```sh
pnpm --filter @experiments/my-thing add zod
pnpm --filter @experiments/my-thing add -D vitest
```

Dev tooling shared across all experiments (typescript, tsx, eslint, prettier, `@types/node`) lives at the root — don't reinstall it per workspace.

## Publishing (GitHub Pages)

The repo is published with GitHub Pages (Settings → Pages → Deploy from a branch → `main`, `/ (root)`). `_config.yml` keeps code and HTTP recordings out of the site; this README is the index. Markdown needs no front matter, since Pages derives each page title from its first heading and turns links to `.md` files into links to the rendered pages. Add each new experiment to the table above. Don’t put Liquid template syntax (two opening curly braces, or an opening curly brace followed by a percent sign) in Markdown: Jekyll would try to evaluate it and the build fails. Wrap such content in a Liquid `raw` block.

## Linting & formatting

ESLint (flat config) and Prettier live at the repo root and apply to every workspace. Config highlights:

- `typescript-eslint` with `recommendedTypeChecked`, plus a local `no-inline-or-dynamic-import` rule.
- Prettier with `@ianvs/prettier-plugin-sort-imports` and `trailingComma: "es5"` (configured inline in the root `package.json`).

No per-experiment lint/format config needed.
