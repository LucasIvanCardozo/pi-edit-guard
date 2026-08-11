# pi-edit-guard

Pi extension that wraps the native `edit` tool with **indentation-drift recovery**, **uniqueness enforcement**, and **batch-aware error reporting**.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends a `oldText` that doesn't match the file's actual indentation, and the edit fails with a generic "Could not find" error. The model then has to either re-read the file (cost) or give up.

`pi-edit-guard` catches these failures and returns the most probable target block with **explicit indentation annotations** so the model can retry correctly. When the model sends multiple atomic edits in one batch, the guard evaluates all of them and produces a single consolidated report so the model can fix everything in one pass instead of N.

## Install

```bash
pi install npm:@lucascardozo/pi-edit-guard
```

## What it does

### Two-layer protection

**Layer 1 — `tool_call` (before native edit runs)**

For each `oldText` in the batch:

1. Counts line-anchored literal occurrences (native edit semantics: match must start at the beginning of a line)
   - 1 unique → pass
   - 0 → continue to step 2
   - > 1 → block with examples
2. Whitespace-normalized exact match (strip leading spaces/tabs per line)
   - 1 unique → block with correctly-indented block
   - > 1 → block with examples
   - 0 → continue to step 3
3. Char-level Levenshtein per line, averaged across the block
   - 1 candidate above threshold (default 0.90) → block with similarity
   - > 1 above threshold → block with examples
   - 0 above threshold → block with best-match hint

**Layer 2 — `tool_result` (when native edit fails)**

Re-runs the same cascade against the file's current state and mutates the error message in-place to point at the most probable target.

### Batch semantics

Both layers iterate over `input.edits[]`. If even one edit has an issue, the whole batch is blocked with a **consolidated report** so the model can fix it in one pass:

```
Edit guard: 2 of 5 edits have issues.

Edit 1: Error: Edit failed. Indentation in your oldText didn't match the file.

sp = spaces, tb = tabs.
The `[Xsp]` / `[Xtb]` markers are descriptive metadata — strip them to get the file's original content.

Lines 5-5. Use the lines below verbatim as your new oldText (after stripping the markers):

```
[4sp]     const b = 2;
```

Edit 4: Found 6 similar blocks (similarity ≥ 0.90).
First 3 examples:
- Lines 3-3:
```
  });
```
- Lines 7-7:
```
  });
```
- Lines 11-11:
```
  });
```

Re-read the file and provide a more specific oldText that uniquely identifies the target block.

Fix the issues above and re-submit the entire batch. Edits already passing will be re-evaluated with the new file state.
```

The consolidated report is the model's single source of truth: it knows exactly which edits failed and why, and can fix all of them in one go instead of N trial-and-error rounds.

### Mutates `event.content` in-place

Other extensions (e.g. `gentle-pi`'s `quiet-tools`) register custom renderers that read `result.content` directly. Returning a `{ content: [...] }` patch from `tool_result` would create a new object that the custom renderer would never see.

`pi-edit-guard` mutates `event.content` in-place so custom renderers pick up the enriched message. It also sets `isError: false` so renderers like `quiet-tools` collapse long output via their `COLLAPSED_TAIL_LINE_LIMIT` (the model still receives the full content — only the visual collapses).

## Output format

### Single edit: drift recovery

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

### Single edit: ambiguous (with examples)

```
Found 13 similar blocks (literal).
First 3 examples:
- Lines 12-14:
```
  });
```
- Lines 47-49:
```
  });
```
- Lines 81-83:
```
  });
```

Re-read the file and provide a more specific oldText that uniquely identifies the target block.
```

### Single edit: no match (with best similarity + hint)

```
No sufficiently similar block found.
Best match: similarity 0.62 at line 47 (below threshold 0.90).

Closest block (lines 47-49):
```
      await triggerOrderStatusChanged(...)
```

Re-read the file to see its current contents before retrying.
```

When the best similarity is below the hint minimum (default 0.50), the closest block is omitted to avoid misleading the model.

### Indent descriptors

Each line of a `unique-drift` candidate is prefixed with a `[Xsp]` / `[Xtb]` marker showing its leading-whitespace count. The marker is descriptive metadata, not part of the file's content — strip it to recover the actual line.

- `4sp` → 4 spaces
- `2tb` → 2 tabs
- `2sp+1tb` → mixed
- `0sp` → no leading whitespace

The legend `sp = spaces, tb = tabs` is **always** visible for the indentation case so the model can interpret the markers without prior knowledge. This addresses the failure mode observed in `carta-qr` (2024) where the model assumed the bullets were indented at 2 spaces based on context, ignored the verbatim block we returned, and re-submitted the same wrong indentation twice before falling back to `read`+`grep`. The per-line marker makes the indent explicit per line even when the block has mixed indents (e.g. some lines `0sp`, others `4sp`).

## Configuration

| Env var | Default | Range | Effect |
|---|---|---|---|
| `PI_EDIT_GUARD_THRESHOLD` | `0.90` | `0..1` | Similarity threshold for fuzzy matches (Level 3). Lower = more permissive. |
| `PI_EDIT_GUARD_EXAMPLES` | `3` | `>=1` | Max number of example blocks shown for ambiguous cases. |
| `PI_EDIT_GUARD_HINT_MIN` | `0.50` | `0..1` | Min similarity to show the closest block as hint in no-match messages. |

Set before launching Pi:

```bash
PI_EDIT_GUARD_THRESHOLD=0.85 pi
PI_EDIT_GUARD_EXAMPLES=5 PI_EDIT_GUARD_HINT_MIN=0.6 pi
```

## What it does NOT do

- It does **not** write to files. The model must retry the edit itself.
- It does **not** auto-fix indentation. The model decides what to do with the suggestion.
- It does **not** change the `bash`, `write`, `read`, or any other tool — only `edit`.

## Testing

A test suite is included in `tests/`. It is split by module so each test runs independently and is fast:

```
tests/
├── _framework.ts              # dependency-free assertion library
├── run.ts                     # test runner (imports all test modules)
├── whitespace.test.ts         # src/whitespace.ts
├── block.test.ts              # src/block.ts
├── matchers/
│   ├── literal.test.ts        # src/matchers/literal.ts
│   ├── normalized.test.ts     # src/matchers/normalized.ts
│   └── fuzzy.test.ts          # src/matchers/fuzzy.ts
├── evaluate.test.ts           # src/evaluate.ts
├── format.test.ts             # src/format.ts
└── extension.test.ts          # src/extension.ts (e2e via jiti)
```

Coverage:
- Unit tests for every pure module (whitespace, block, each matcher, evaluate, format)
- E2E test that loads the extension via jiti (same loader Pi uses), registers hooks, and fires events with real files
- Regression cases from v0.5.0 (drift, fuzzy, ok, ambiguous)
- The 3 surrender events observed in production logs (where models gave up on `edit` and switched to `python`/`bash` after 2-3 failed attempts)
- Batch semantics: 1 of 5 edits fails → consolidated report
- CRLF normalization, edge cases, max-examples limit

Run with:

```bash
pnpm test          # one-shot
pnpm test:watch    # watch mode
pnpm run typecheck
```

(uses Node 22+ `--experimental-strip-types`, no build step required)

## Project structure

```
pi-edit-guard/
├── index.ts                 # entry point (re-export from src/extension.ts)
├── src/
│   ├── extension.ts         # composition root: default export with tool_call/tool_result hooks
│   ├── evaluate.ts          # evaluateEdit, evaluateBatch (pure cascade)
│   ├── format.ts            # all user-facing message formatting
│   ├── mutate.ts            # in-place mutation of tool result events
│   ├── config.ts            # env var readers and constants
│   ├── types.ts             # shared EditEvaluation and CandidateKind types
│   ├── block.ts             # BlockExcerpt type and toBlockExcerpt adapter
│   ├── whitespace.ts        # stripLeadingWhitespace, normalizeText, describeIndent
│   └── matchers/
│       ├── index.ts         # barrel re-export
│       ├── literal.ts       # countLineAnchoredMatches, findLineAnchoredMatches
│       ├── normalized.ts    # findNormalizedMatches
│       └── fuzzy.ts         # findFuzzyMatches, lineCharSimilarity, levenshteinDistance
├── tests/                   # (see Testing section)
├── README.md
├── LICENSE
└── package.json
```

Each module has one responsibility. To add a new matcher (e.g. AST-based), create a file in `src/matchers/` and add it to the barrel. To add a new output format, add a function to `src/format.ts`. The cascade in `src/evaluate.ts` is the only place that knows about the order of matchers.

## Compatibility

- **Pi**: 0.84+
- **Node**: 22+ (uses native `--experimental-strip-types` for tests, `node:fs/promises` for runtime)
- **TypeScript**: source-only (Pi loads via jiti, no build step required)

## Tested alongside

- `gentle-pi` v2.1.2 with `quiet-tools.ts` enabled — works correctly, custom renderer respects the mutation

## License

MIT
