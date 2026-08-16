# pi-edit-guard

Pi extension that wraps the native `edit` tool with **silent auto-fix**, **uniqueness enforcement**, and **batch-aware error reporting**.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends an `oldText` that doesn't match the file's actual indentation, and the edit fails with a generic "Could not find" error. The model then has to either re-read the file (cost) or give up.

`pi-edit-guard` **silently corrects** these failures for the most common case (uniform leading-space shift) by mutating `event.input` in place and letting native edit run with corrected `oldText`/`newText`. When the failure is more complex (ambiguous match, character difference, no match), it surfaces a consolidated report so the model can fix everything in one pass instead of N.

## Install

```bash
pi install npm:@lucascardozo/pi-edit-guard
```

## What it does

### Two-layer protection

**Layer 1 — `tool_call` (before native edit runs)**

For each `oldText` in the batch:

1. Counts line-anchored literal occurrences (native edit semantics: match must start at the beginning of a line)
   - 1 unique → pass through
   - 0 → continue to step 2
   - > 1 → block with examples
2. Whitespace-normalized exact match (strip leading spaces per line)
   - 1 unique → **auto-fix path** (silent, see below) or block if auto-fix can't apply
   - > 1 → block with examples
   - 0 → continue to step 3
3. Char-level Levenshtein per line, averaged across the block
   - 1 candidate above threshold (default 0.90) → block with similarity
   - > 1 above threshold → block with examples
   - 0 above threshold → block with best-match hint

**Auto-fix (silent success)** — when the cascade resolves to `unique-drift` with a uniform leading-space shift, `pi-edit-guard` mutates the edit in place:

- `oldText` is replaced with the file's verbatim block (the cascade already guarantees this matches).
- `newText` is shifted by the same delta, per non-blank line.
- For the cases auto-fix declines (non-uniform drift, tabs, large delta), the model gets a clear verdict + the file's verbatim block. Future versions will optionally delegate those to a configured post-edit formatter (`PI_EDIT_GUARD_FORMATTER`, see Configuration table) as a safety net.

**No-op detection** — when `oldText === newText`, the edit would make no change. Pi's native edit rejects this with a misleading *"No changes made... special characters or text not existing"* message. `pi-edit-guard` catches it before the cascade and returns a clear, actionable verdict so the model knows it sent a no-op.
- The model receives a normal edit-success result. No error message, no retry cost.

Auto-fix **declines** (and falls back to the block path) with a specific reason when:

- `missing-text` — `oldText` or `newText` is empty/missing.
- `line-count-mismatch` — `oldText` has different line count than the matched file block.
- `tab-in-oldtext` — `oldText` uses tabs (spaces-only file assumption).
- `tab-in-newtext` — any line of `newText` has a leading tab (would write mixed-indent).
- `tab-in-file-block` — the matched file block uses tabs.
- `non-uniform-delta` — different non-blank lines need different shifts (not a clean shift mistake).
- `zero-delta` — `oldText` already matches (cascade would have returned `ok-literal` anyway).
- `delta-too-large` — defensive cap of ±50 spaces exceeded.

The decline reason attaches to the `EditEvaluation` and is surfaced as a specific hint in the consolidated report so the model can correct on the next try instead of looping.

**Layer 2 — `tool_result` (when native edit fails atomically)**

Re-runs the cascade against the file's current state and mutates the error message in-place to surface the most probable target.

### Batch semantics

Both layers iterate over `input.edits[]`. The atomicity rule: when the cascade resolves to auto-fixable for some edits but unfixable for others, the entire batch is blocked with a **consolidated report** so the model can fix everything in one pass:

```
Edit guard: 1 of 2 edits have issues.

Edit 2: Found 6 similar blocks (similarity ≥ 0.90).
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

### Mutates events in-place

- `tool_call`: mutates `event.input.edits[i].oldText` and `.newText` in place when auto-fix applies. The Pi runtime applies mutations across handlers; native edit then runs with the corrected arguments.
- `tool_result`: mutates `event.content` in place so custom renderers (e.g. `gentle-pi`'s `quiet-tools`) pick up the enriched message. `isError` is set to `false` so renderers like `quiet-tools` collapse long output via their `COLLAPSED_TAIL_LINE_LIMIT`.

## Output format

### Single edit: fuzzy-match (character difference)

When auto-fix doesn't apply and the cascade surfaces a fuzzy match:

```
Error: Edit failed. Your oldText had a small difference from the file.

Lines 12-12. Use this block verbatim as your new oldText:

```
    return 11;
```
(similarity 0.92)
```

### Single edit: drift recovery (unfixable case)

When auto-fix declines (e.g. the file uses tabs, or the delta is non-uniform), the consolidated report includes the specific decline reason so the model knows what to fix:

```
Error: Edit failed. Indentation in your oldText didn't match the file.

Lines 12-16. Use these lines verbatim as your new oldText (including leading whitespace):

```
    if (item % 2 === 0) {
      return acc + item * 2;
    } else {
      return acc + item;
    }
```
(Hint: autofix declined — tab detected in newText line 3. Replace the tab with spaces to match the file's indent.)
```

The block is the file's actual lines, byte-exact. The model copies them as-is — no transformation needed. The hint narrows the retry to a specific cause.

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

## Debug logging (production triage)

The debug logger is **on by default**: every cascade invocation writes one NDJSON line to `/tmp/pi-edit-guard-<pid>.log` with full `oldText` / `newText` content and a verbatim file snapshot under `/tmp/pi-edit-guard-<pid>/snapshots/<sha>.orig`. No env vars needed to turn any of this on.

If you want to silence one of the three flags, set it to `0`:

```bash
PI_EDIT_GUARD_DEBUG=0 \              # silence the NDJSON log
PI_EDIT_GUARD_LOG_FULL=0 \            # redact to sha + length + 200-char preview
PI_EDIT_GUARD_LOG_SNAPSHOTS=0 \      # skip file snapshots
pi
```

Fields per log entry:

| Field | Meaning |
|---|---|
| `source` | `'tool_call'` \| `'tool_result'` — which hook fired. Pair the two to see what we intercepted vs what native returned. |
| `path` | File path the edit targets. |
| `fileBytes` / `fileSha` / `filePreview` | Length, sha256 (12 hex), and the file content (full when `LOG_FULL` is on; first 200 chars + `[+N chars]` when redacted). |
| `fileLeadingNewlines` / `fileTrailingNewlines` | Helpful to spot BOM or trailing-newline mismatches. |
| `edits[i].oldTextBytes` / `oldTextSha` / `oldTextPreview` / `oldTextLeadingSpaces` | What the model sent (full content by default; redacted when `LOG_FULL=0`). |
| `edits[i].newTextBytes` / `newTextSha` / `newTextPreview` / `newTextLeadingSpaces` | What the model wants to write. |
| `edits[i].evaluationKind` | `ok-literal`, `unique-drift`, `fuzzy-match`, `ambiguous-*`, `no-match`. |
| `edits[i].autofixOutcome` | `ok` (with `autofixDelta`) \| `declined` (with `declineReason`) \| `n/a`. |
| `result` | `autofixed` \| `blocked` (with `blockReasonBytes`) \| `pass` \| `pass-oversized` \| `pass-unreadable`. |
| `autofixedCount` | Number of edits silently corrected (only present when `result: 'autofixed'`). |
| `snapshotPath` | Absolute path to the saved file snapshot (always present by default; absent when `LOG_SNAPSHOTS=0`). |
| `nativeError` | What the native edit tool returned (only on `tool_result` events with `isError`). Shows what the model actually saw. |

The log rotates at 5 MB. Snapshots are capped at 200 files / 100MB total (oldest by mtime get pruned).

### Custom log path

```bash
PI_EDIT_GUARD_LOG_PATH=./edit-guard.log pi
```

Snapshots go to `./snapshots/` (i.e. `<dirname(log-path)>/snapshots/`).

### Triage workflow

1. Reproduce the issue with the default config (no env vars needed — everything is on).
2. `cat <log-path> | jq .` (or use any NDJSON viewer).
3. Filter by `source` to see what the extension intercepted (`tool_call`) vs what came back from native (`tool_result`). On `tool_result` with `nativeError`, you'll see exactly what the model saw.
4. If `snapshotPath` is set, `cat <snapshotPath>` shows the file at edit time.
5. Compare `oldTextLeadingSpaces` vs the snapshot's leading whitespace per line — this is the smoking gun for any "I copied verbatim but it doesn't match" mystery.

## Configuration

| Env var | Default | Opt-out | Effect |
|---|---|---|---|
| `PI_EDIT_GUARD_THRESHOLD` | `0.90` | n/a | Similarity threshold for fuzzy matches (Level 3). Lower = more permissive. |
| `PI_EDIT_GUARD_EXAMPLES` | `3` | n/a | Max number of example blocks shown for ambiguous cases. |
| `PI_EDIT_GUARD_HINT_MIN` | `0.50` | n/a | Min similarity to show the closest block as hint in no-match messages. |
| `PI_EDIT_GUARD_DEBUG` | **ON** | `=0` | NDJSON debug log written per cascade invocation. |
| `PI_EDIT_GUARD_LOG_PATH` | `/tmp/pi-edit-guard-<pid>.log` | n/a | Where the NDJSON log goes. Snapshot dir is `<dirname>/snapshots/`. |
| `PI_EDIT_GUARD_LOG_FULL` | **ON** | `=0` | Log full `oldText`/`newText` content instead of 200-char preview. |
| `PI_EDIT_GUARD_LOG_SNAPSHOTS` | **ON** | `=0` | Save a verbatim copy of the file at edit time to `<log-dir>/snapshots/<sha>.orig`. Dedupe by sha, capped at 200 files / 100MB. |
| `PI_EDIT_GUARD_FORMATTER` | unset | `=0` | Post-edit formatter command (v0.10.0). Bare alias (`biome`, `prettier`, `black`, `gofmt`, `rustfmt`) or full command (`"prettier --write"`). Optional safety net for cases autofix declines. |

All three log flags default to ON. Set the env var to `0`, `false`, or `no` to disable that flag. `1` / `true` / `yes` still works (redundant with default but explicit).

Set before launching Pi:

```bash
PI_EDIT_GUARD_THRESHOLD=0.85 pi
PI_EDIT_GUARD_EXAMPLES=5 PI_EDIT_GUARD_HINT_MIN=0.6 pi
PI_EDIT_GUARD_DEBUG=1 pi   # capture session for triage
```

## What it does NOT do

- It does **not** silently fix content differences, only indentation drift with a uniform leading-spaces shift.
- It does **not** suppress errors for tabs or non-uniform drift — those fall through to the existing block+report path, now with a specific decline hint.
- It does **not** change the `bash`, `write`, `read`, or any other tool — only `edit`.

## Testing

A test suite is included in `tests/`. It is split by module so each test runs independently and is fast:

```
tests/
├── _framework.ts              # dependency-free assertion library
├── run.ts                     # test runner (imports all test modules)
├── autofix.test.ts            # src/autofix.ts (delta + shift logic + decline reasons)
├── whitespace.test.ts         # src/whitespace.ts
├── block.test.ts              # src/block.ts
├── debug.test.ts              # src/debug.ts (NDJSON logger)
├── matchers/
│   ├── literal.test.ts        # src/matchers/literal.ts
│   ├── normalized.test.ts     # src/matchers/normalized.ts
│   └── fuzzy.test.ts          # src/matchers/fuzzy.ts
├── evaluate.test.ts           # src/evaluate.ts
├── format.test.ts             # src/format/* (all output formats)
└── extension.test.ts          # src/extension.ts (e2e via jiti)
```

Coverage:
- Unit tests for every pure module (whitespace, block, autofix, each matcher, evaluate, format, debug)
- E2E test that loads the extension via jiti (same loader Pi uses), registers hooks, and fires events with real files
- Regression cases from v0.5.0/v0.6.0 (drift, fuzzy, ok, ambiguous)
- Autofix happy path (uniform shift) + decline paths (tabs, non-uniform, MAX_SANE_DELTA, line-count, missing)
- Decline-reason assertions per `AutofixDeclineReason` variant
- Batch semantics: atomic block when one edit can't be auto-fixed
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
│   ├── autofix.ts           # tryAutofix — pure leading-spaces delta + shift logic + decline reasons
│   ├── mutate.ts            # in-place mutation of tool result events
│   ├── config.ts            # env var readers and constants
│   ├── debug.ts             # opt-in NDJSON debug logger
│   ├── types.ts             # shared EditEvaluation and CandidateKind types
│   ├── block.ts             # BlockExcerpt type and toBlockExcerpt adapter
│   ├── whitespace.ts        # stripLeadingWhitespace, normalizeText (spaces-only)
│   ├── format/
│   │   ├── index.ts         # barrel re-export
│   │   ├── candidate.ts     # formatCandidate: fuzzy-match + unfixable drift
│   │   ├── ambiguous.ts     # formatAmbiguousMessage + formatExamples
│   │   ├── consolidated.ts  # formatConsolidatedReport (atomic block output)
│   │   └── no-match.ts      # formatNoMatchMessage (best-similarity hint)
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

Each module has one responsibility. To add a new matcher (e.g. AST-based), create a file in `src/matchers/` and add it to the barrel. To add a new output format, add a function under `src/format/`. The cascade in `src/evaluate.ts` is the only place that knows about the order of matchers.

## Compatibility

- **Pi**: 0.84+
- **Node**: 22+ (uses native `--experimental-strip-types` for tests, `node:fs/promises` for runtime)
- **TypeScript**: source-only (Pi loads via jiti, no build step required)

## Tested alongside

- `gentle-pi` v2.1.2 with `quiet-tools.ts` enabled — works correctly, custom renderer respects the mutation

## License

MIT