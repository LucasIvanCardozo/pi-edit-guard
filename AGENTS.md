# AGENTS.md

Quick context for working on `@lucascardozo/pi-edit-guard`.

## What this is

Pi extension that wraps the native `edit` tool with batch-aware protection:

1. **`tool_call` hook** — intercepts before native edit runs. Processes **every edit in the batch** (not just the first). If any `oldText` has issues (ambiguous, drift, fuzzy, no-match), blocks the entire batch with a consolidated report so the model can fix everything in one pass.
2. **`tool_result` hook** — catches native edit failures (atomic: if one edit fails, the whole batch returns an error). Re-runs the cascade and mutates the error in-place.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends a non-matching `oldText`, and after 2-3 failed edits the model gives up and switches to `bash`/`python` (surrender pattern observed in production logs).

## Status

- **v0.6.1 in development** (per-line indent markers + CRLF fix)
- Install: `pi install npm:@lucascardozo/pi-edit-guard`
- Repo: https://github.com/LucasIvanCardozo/pi-edit-guard
- License: MIT

## File layout

Multi-file source-only extension. No build step. Pi loads `index.ts` via jiti; `index.ts` re-exports from `src/extension.ts`.

```
index.ts                 entry point (thin barrel)
src/
├── extension.ts         composition root: default export with tool_call/tool_result hooks
├── evaluate.ts          evaluateEdit, evaluateBatch (pure cascade)
├── format.ts            all user-facing message formatting
├── mutate.ts            in-place mutation of tool result events
├── config.ts            env var readers and constants
├── types.ts             shared EditEvaluation, CandidateKind types
├── block.ts             BlockExcerpt type and toBlockExcerpt adapter
├── whitespace.ts        stripLeadingWhitespace, normalizeText, describeIndent
└── matchers/
    ├── index.ts         barrel re-export
    ├── literal.ts       countLineAnchoredMatches, findLineAnchoredMatches
    ├── normalized.ts    findNormalizedMatches
    └── fuzzy.ts         findFuzzyMatches, lineCharSimilarity, levenshteinDistance
tests/                   see "Testing" section
README.md                install + usage
LICENSE                  MIT
AGENTS.md                this file
```

## Architecture

### Cascade (per edit)

1. **Literal line-anchored count** — match must start at the beginning of a line. This is the bug fix vs v0.5.0: the old `split().length - 1` counted substrings, so `"  return 1;"` would match inside `"    return 1;"` as a false positive.
2. **Whitespace-normalized exact match** — strip leading spaces/tabs per line, look for exact match.
3. **Char-level Levenshtein per line, averaged** — char-level similarity per line, averaged across the block.

Each step resolves to one of:
- `ok-literal` — pass through
- `unique-drift` — block with correctly-indented block (one normalized match)
- `fuzzy-match` — block with similarity (one fuzzy match)
- `ambiguous-{literal,normalized,fuzzy}` — block with up to 3 example blocks
- `no-match` — block with best-similarity score + (optionally) closest block as hint

### Composition root (`src/extension.ts`)

This is the only file that knows about the Pi runtime. Everything else in `src/` is pure and reusable. The hooks wire together config, evaluation, formatting, and mutation.

```ts
pi.on("tool_call", async (event) => {
  // Read file → evaluateBatch (every edit) → formatConsolidatedReport → block if any issue
});

pi.on("tool_result", async (event) => {
  // Same cascade; mutate event.content in-place so quiet-tools sees our message
});
```

### CRITICAL: mutate `event.content` in-place, don't return patch

```ts
export function mutateToolResult(event, newText, isError) {
  if (Array.isArray(event.content) && event.content.length > 0) {
    event.content[0] = { type: "text", text: newText };
  } else {
    event.content = [{ type: "text", text: newText }];
  }
  event.isError = isError;
}
```

**Why mutate, not patch**: Other extensions (`gentle-pi`'s `quiet-tools` for example) register custom renderers that read `result.content` directly. Returning `{ content: [...] }` creates a new object that the custom renderer never sees — the user keeps seeing the native "Could not find the exact text" error.

We also set `isError: false` so renderers like `quiet-tools` collapse the output via `COLLAPSED_TAIL_LINE_LIMIT`. The model still receives the full content (the mutation doesn't truncate anything).

## Conventions

### Candidate message format (fenced code block, copy-pasteable)

For the `unique-drift` case, the block is wrapped in a Markdown fenced code block. Each line is prefixed with a `[Xsp]` / `[Xtb]` marker showing its leading-whitespace count. The marker is **descriptive metadata, not part of the file's content** — strip it to recover the actual line. The legend `sp = spaces, tb = tabs` is always visible for the drift case so the model can interpret the markers without prior knowledge.

```
Error: Edit failed. Indentation in your oldText didn't match the file.

sp = spaces, tb = tabs.
The `[Xsp]` / `[Xtb]` markers are descriptive metadata — strip them to get the file's original content.

Lines 12-16. Use the lines below verbatim as your new oldText (after stripping the markers):

```
[8sp]         if (item % 2 === 0) {
[10sp]           return acc + item * 2;
[8sp]         } else {
[10sp]           return acc + item;
[8sp]         }
```
```

**Why per-line markers (instead of plain verbatim block):** addresses the failure mode observed in `carta-qr` (2024) where the model assumed the bullets were indented at 2 spaces based on context, ignored the verbatim block we returned, and re-submitted the same wrong indentation twice before falling back to `read`+`grep`. The per-line marker makes the indent explicit per line even when the block has mixed indents (e.g. some lines `0sp`, others `4sp`).

**Indent descriptors**:
- `4sp` → 4 spaces
- `2tb` → 2 tabs
- `2sp+1tb` → mixed
- `0sp` → no leading whitespace

The `0sp` form (rather than `-` for "no indent") keeps the marker format uniform: every line gets `[Xsp]` or `[Xtb]`. The model doesn't need to learn a special-case symbol.

### Message rules (no redundancies)

- **DON'T** include `Edit failed: oldText not found in /path` — path is already in the tool header, "oldText not found" is implied by the rest
- **DON'T** include `Retry using this exact text as oldText, preserving the indentation shown` — too verbose, the model knows what to do
- **DO** start directly with the actionable info (`Error: Edit failed. ...`, `Found N similar blocks.`, `No sufficiently similar block found.`)
- The instruction line `Use this block as your new oldText in your next edit call:` appears ONCE, right before the block.
- The block is shown as a fenced code block with `[Xsp]` / `[Xtb]` prefixes per line (drift case only). The model strips these markers to get the verbatim content. The fuzzy case keeps a plain verbatim block (no markers).
- The header distinguishes two cases:
  - `Indentation in your oldText didn't match the file.` (normalized match: pure indentation drift)
  - `Your oldText had a small difference from the file.` (fuzzy match: typos, small character differences)

## Configuration

```bash
PI_EDIT_GUARD_THRESHOLD=0.85 pi  # lower = more permissive fuzzy matching
```

Default: `0.90`. Lower if you want the guard to catch more typos; higher if you want stricter matches only.

## Lessons learned (gotchas)

1. **`input.edits[0].oldText`**, NOT `input.oldText`. Pi's edit tool takes an `edits` array. The first attempt of this extension silently no-op'd because of this.

2. **Empty `oldText` → infinite loop** in `findNormalizedMatches` via `indexOf("", pos)` always returning `pos` and `pos += ""` not advancing. Guard added: `if (!normalizedOldText || normalizedOldText.trim() === "") return [];`

3. **Custom renderers need in-place mutation.** Returning `{ content: [...] }` from `tool_result` creates a new object that bypasses renderers like `quiet-tools` which read `result.content` directly.

4. **Similarity was binary for 1-line blocks.** Original formula `1 - lineDistance/maxLines` gave similarity 0 or 1 when windowSize=1. Fixed by switching to char-level Levenshtein per line, averaged: `totalSim / windowSize`.

5. **`isError: false` makes quiet-tools collapse.** When `isError: true`, the renderer shows full output. Setting `false` triggers `COLLAPSED_TAIL_LINE_LIMIT` (10 lines), making the TUI compact while the model still gets everything.

## Testing

118 automated tests across 8 modules, no deps:

```bash
pnpm test          # one-shot (uses node --experimental-strip-types)
pnpm test:watch    # watch mode
pnpm run typecheck # tsc --noEmit
```

Test layout (one file per source module, plus an e2e test that loads the extension via jiti):

```
tests/
├── _framework.ts                  # dependency-free assert/assertEq/assertMatch
├── run.ts                         # runner: imports all test modules in order
├── whitespace.test.ts             # src/whitespace.ts
├── block.test.ts                  # src/block.ts
├── matchers/
│   ├── literal.test.ts            # src/matchers/literal.ts
│   ├── normalized.test.ts         # src/matchers/normalized.ts
│   └── fuzzy.test.ts              # src/matchers/fuzzy.ts
├── evaluate.test.ts               # src/evaluate.ts (cascade)
├── format.test.ts                 # src/format.ts (all output formats)
└── extension.test.ts              # src/extension.ts (e2e via jiti)
```

Coverage includes the 3 surrender events observed in production logs (where models gave up on `edit` and switched to `python`/`bash` after 2-3 failed attempts), regression cases from v0.5.0, and batch semantics (1 of 5 edits fails → consolidated report).

## Compatibility

- **Pi**: 0.84+
- **Node**: 20+
- **Tested with**: `gentle-pi` v2.1.2 with `quiet-tools.ts` enabled — works correctly

## Publishing

```bash
# After making changes
git add .
git commit -m "..."
git push
git tag v0.x.y
git push --tags

# Publish (requires npm token with 2FA bypass for the @lucascardozo scope)
npm publish --access public
```

Token must be created at https://www.npmjs.com/settings/tokens → Automation → with **Bypass two-factor authentication** enabled, scoped to `@lucascardozo`.

## Roadmap candidates (v0.7.0+)

- Adaptive threshold (stricter for long blocks, more lenient for short)
- Path exclusion config (e.g., skip `*.lock` files)
- New matchers: regex-based, AST-based
- Metrics for false positives vs false negatives
- Telemetry opt-in for evaluating threshold defaults