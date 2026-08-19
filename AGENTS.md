# AGENTS.md

Quick context for working on `@lucascardozo/pi-edit-guard`.

## What this is

Pi extension that wraps the native `edit` tool with batch-aware protection:

1. **`tool_call` hook** — intercepts before native edit runs. Processes **every edit in the batch** (not just the first). For unique indent drift, silently auto-fixes the leading-space shift in `event.input.edits[i]` in place. For ambiguous, fuzzy, or no-match cases (or drift that can't be auto-fixed), blocks the entire batch with a consolidated report so the model can fix everything in one pass.
2. **`tool_result` hook** — catches native edit failures (atomic: if one edit fails, the whole batch returns an error). Re-runs the cascade and mutates the error in-place.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends a non-matching `oldText`, and after 2-3 failed edits the model gives up and switches to `bash`/`python` (surrender pattern observed in production logs). The auto-fix path closes this loop entirely for the most common case — pure leading-space drift.

## Status

- **v0.12.0 in development** — formatter safety net integrated (adapted from pi-code-formatter by losnappas, MIT)
- Install: `pi install npm:@lucascardozo/pi-edit-guard`
- Repo: https://github.com/LucasIvanCardozo/pi-edit-guard
- License: MIT

## File layout

Multi-file source-only extension. No build step. Pi loads `index.ts` via jiti; `index.ts` re-exports from `src/extension.ts`.

```
index.ts                       entry point (thin barrel)
src/
├── extension.ts               composition root: default export with tool_call/tool_result hooks
├── evaluate.ts                evaluateEdit, evaluateBatch (pure cascade)
├── autofix.ts                 tryAutofix — pure leading-space shift computation
├── mutate.ts                  in-place mutation of tool result events
├── config.ts                  env var readers and constants
├── types.ts                   shared EditEvaluation, CandidateKind types
├── block.ts                   BlockExcerpt type and toBlockExcerpt adapter
├── whitespace.ts              stripLeadingWhitespace, normalizeText (spaces-only)
├── formatter-config.ts        loadConfig, resolveFormatters, findFormatter (config schema + pattern compilation)
├── format/
│   ├── index.ts               barrel re-export
│   ├── candidate.ts           formatCandidate: fuzzy-match + unfixable drift
│   ├── ambiguous.ts           formatAmbiguousMessage + formatExamples
│   ├── consolidated.ts        formatConsolidatedReport (atomic block output)
│   └── no-match.ts            formatNoMatchMessage (best-similarity hint)
│   ├── runner.ts              runFormatter via pi.exec (formatter subprocess)
│   └── tool-result-rewriter.ts generateRewriteResult: original → formatted patch/diff
└── matchers/
    ├── index.ts               barrel re-export
    ├── literal.ts             countLineAnchoredMatches, findLineAnchoredMatches
    ├── normalized.ts          findNormalizedMatches
    └── fuzzy.ts               findFuzzyMatches, lineCharSimilarity, levenshteinDistance
tests/                         see "Testing" section
README.md                      install + usage
LICENSE                        MIT
AGENTS.md                      this file
```

## Architecture

1. **Literal line-anchored count** — match must start at the beginning of a line. Bug fix vs v0.5.0: the old `split().length - 1` counted substrings, so `"  return 1;"` would match inside `"    return 1;"` as a false positive.
2. **Whitespace-normalized exact match** — strip leading spaces per line, look for exact match.
3. **Char-level Levenshtein per line, averaged** — char-level similarity per line, averaged across the block.

Each step resolves to one of:
- `ok-literal` — pass through, native edit runs as-is
- `unique-drift` — pure leading-space shift; **auto-fix path** (silent) or block (when auto-fix can't apply)
- `fuzzy-match` — block with character-diff example (fuzzy verified, model decides whether to retry)
- `ambiguous-{literal,normalized,fuzzy}` — block with up to 3 example blocks
- `no-match` — block with best-similarity score + (optionally) closest block as hint

### Auto-fix path (silent success)

When the cascade resolves to `unique-drift`, `tryAutofix` in `src/autofix.ts` computes a uniform `delta` (the difference in leading-space count between the model's `oldText` and the file's matched block, per non-blank line). If the delta is uniform and within defensive bounds:

1. Mutate `event.input.edits[i].oldText` to the file's verbatim block — the cascade already guarantees this matches.
2. Mutate `event.input.edits[i].newText` to apply the same shift to each line.
3. Return `undefined` from the hook — native edit runs with the corrected arguments.

This closes the surrender pattern for the most common failure mode. The model never sees an error message; the edit just succeeds.

Auto-fix **declines** (returns `null`) when:
- `oldText` or the file block contains tabs (the project assumes spaces-only; tabs return to the existing block+report path)
- The delta is non-uniform across non-blank lines (model's error is not a clean shift mistake)
- The line counts differ between model `oldText` and the file block (cascade guarantees they shouldn't, but defended against)
- Delta exceeds `MAX_SANE_DELTA` (50 spaces; defensive bug-cap)
- `oldText` or `newText` is missing/empty

When auto-fix declines AND any other verdict in the batch is unfixable (fuzzy, ambiguous, no-match, or unfixable drift), the whole batch is **atomically blocked** with a consolidated report — no partial-fix permitted.

### Composition root (`src/extension.ts`)

The only file that knows about the Pi runtime. Everything else in `src/` is pure and reusable. The hooks wire together config, evaluation, autofix, formatting, and mutation.

```ts
pi.on("tool_call", async (event) => {
  // Read file once → evaluateBatch (every edit) → tryAutofix per unique-drift
  //   → if all resolved, mutate event.input and return undefined (native edit runs)
  //   → if any unfixable, block with formatConsolidatedReport
  //   → if all resolved, mutate event.input and return undefined (native edit runs)
  //   → if any unfixable, block with formatConsolidatedReport
  //   → in trust-formatter mode, autofix is skipped; cascade still validates
});

pi.on("tool_result", async (event) => {
  // Re-run cascade on current file state; mutate event.content in-place (quiet-tools compat).
  // In trust-formatter mode, the cascade skips autofix and passes newText verbatim.
});
```

### Architecture: autofix as fast path, formatter as safety net (v0.10.0 target)

The autofix layer is the **in-process, deterministic, fast path** for indent drift. It handles the ~80% common case with zero subprocess overhead. In trust-formatter mode (opt-in), autofix is skipped entirely and the cascade passes `newText` verbatim — designed for projects that run an external formatter (`pi-autoformat`, biome, prettier, etc.) alongside.

Autofix declines (atomic block) when:
- `tab-in-oldtext` / `tab-in-newtext` / `tab-in-file-block` — tabs are not in scope (spaces-only assumption).
- `non-uniform-delta` — different non-blank lines need different shifts. Applying uniform shift would corrupt multi-level structure.
- `delta-too-large` — `|delta| > 50` exceeds defensive cap.
- `line-count-mismatch` — oldText and file block have different line counts.
- `missing-text` — oldText/newText empty.

### Formatter integration (v0.12.0 — opt-in)

When a formatter is configured for the file (via `.pi/extensions/pi-edit-guard/config.json`
or `~/.pi/agent/extensions/pi-edit-guard/config.json`), the extension operates
in **formatter-trust mode**:

1. `session_start` handler loads and resolves the config once. Formatters are
   stored in module-level `resolvedFormatters: ResolvedFormatter[]`.
2. `tool_call` handler computes `findFormatter(resolvedFormatters, filePath)`
   and, if a match exists, captures the file's pre-edit content in
   `originalContents: Map<string, string>`.
3. The matched formatter propagates into `processEditInput` as
   `matchedFormatter`, which makes the cascade skip the autofix layer
   (same as `trustFormatter` mode — the formatter will normalize drift
   post-edit). Ambiguous/fuzzy/no-match still block.
4. `tool_result` (success only) handler runs the formatter via `pi.exec`
   (5s timeout, `--` separator + absolute path) and rewrites
   `details.{patch, diff, firstChangedLine}` from `original → formatted`.
   This is the trick that closes the surrender pattern: the model sees
   the atomic final state, never the intermediate drift.

The diff is computed from `originalContent` (captured pre-edit) to
`formattedContent` (after formatter runs), NOT from the post-edit
`newText` to the formatted content. This way, if the model wrote `newText`
with the wrong indent and the formatter fixed it, the model sees the
final result cleanly.

Adapted from [pi-code-formatter](https://github.com/losnappas/pi-code-formatter)
by losnappas (MIT). Pattern compilation, config schema, tool_result
rewriting, and `pi.exec` runner pattern ported from that extension.

### No-op detection (v0.9.0)

When `oldText === newText`, the edit would make no change. Pi's native edit rejects this with a misleading *"No changes made... special characters or text not existing"* message. `evaluateBatch` detects this before the cascade and returns `kind: 'no-op'`. The formatter renders it as a clear, actionable verdict. Atomic semantics: a single no-op blocks the whole batch — the model retries with a real change or removes the edit.

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

**Tool-call mutation** (`event.input.edits[i].oldText` / `.newText`) is also in-place. The Pi runtime mutates `event.input` for `tool_call` handlers; later handlers see earlier mutations.

## Conventions

### Spaces-only assumption

The project assumes files use leading SPACES only (no tabs). Tabs are treated as content, not indent. This simplification:

- `whitespace.ts::stripLeadingWhitespace` only strips spaces (was spaces+tabs).
- `autofix.ts::tryAutofix` returns `null` when any line has a leading tab → cascades to the block+report path.
- The legend, indent descriptors, and format output all use `sp` for spaces. There is no `tb` variant.

If you need tab support in the future, see the `Roadmap` section. For now the simplification buys us cleaner tests, simpler delta computation, and a uniform-shift invariant that auto-fix can rely on.

### Candidate message format (fenced code block, copy-pasteable)

For `fuzzy-match` and unfixable `unique-drift`, the block is the file's lines verbatim. The model can copy them as its new `oldText` without any transformation:

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
```

For `fuzzy-match`, the header reads `Your oldText had a small difference from the file.` and the message includes `(similarity 0.95)`.

### Message rules (no redundancies)

- **DON'T** include `Edit failed: oldText not found in /path` — path is already in the tool header, "oldText not found" is implied by the rest.
- **DON'T** include `Retry using this exact text as oldText, preserving the indentation shown` — too verbose, the model knows what to do.
- **DO** start directly with the actionable info (`Error: Edit failed. ...`, `Found N similar blocks.`, `No sufficiently similar block found.`).
- The instruction line appears ONCE, right before the block.
- The block is shown as a fenced code block. The model copies it as-is — no markers to strip, no transformation needed (the v0.6 per-line `[Xsp]` markers were removed because auto-fix handles the common case silently).
- The header distinguishes two cases:
  - `Indentation in your oldText didn't match the file.` (normalized match: pure indentation drift, unfixable)
  - `Your oldText had a small difference from the file.` (fuzzy match: typos, small character differences)

## Configuration

```bash
PI_EDIT_GUARD_THRESHOLD=0.85 pi  # lower = more permissive fuzzy matching
```

Default: `0.90`. Lower if you want the guard to catch more typos; higher if you want stricter matches only.

Debug logging is **ON by default** — every cascade invocation writes one NDJSON line with full `oldText` / `newText` content plus a verbatim file snapshot under `<log-dir>/snapshots/<sha>.orig`. To silence:

```bash
PI_EDIT_GUARD_DEBUG=0 \                # silence the NDJSON log
PI_EDIT_GUARD_LOG_FULL=0 \              # redact to sha + length + 200-char preview
PI_EDIT_GUARD_LOG_SNAPSHOTS=0 \        # skip file snapshots
pi
```

Log entries include `source` (`tool_call` | `tool_result`) and, on `tool_result` with `isError`, `nativeError` so we can see exactly what the model saw. See the README "Debug logging" section for the full triage workflow.

### Trust-formatter mode (v0.11.0 — opt-in)

When `PI_EDIT_GUARD_TRUST_FORMATTER=1` (or `--trust-formatter`), the guard skips the autofix layer entirely. The cascade still validates that there's a match, but in trust mode:

- `ok-literal` → pass through (no change)
- `unique-drift` (any kind — uniform, non-uniform, tabs, large delta) → pass through with the model's `newText` verbatim. The external formatter (e.g. `pi-autoformat`, biome, prettier) running alongside is responsible for normalizing indent drift.
- `ambiguous-*` / `fuzzy-match` / `no-match` → still blocked with the consolidated report. The cascade validates; if there's no safe match, the model has to fix its `oldText` and retry.

Designed for projects that run `pi-autoformat` (or any other post-edit formatter) alongside this extension. Decouples the indent-correction responsibility: the extension only validates that there IS a match; the formatter handles drift.

```bash
PI_EDIT_GUARD_TRUST_FORMATTER=1 pi   # opt-in
pi --trust-formatter                  # CLI flag (registered for discoverability)
```

The flag is registered with `pi.registerFlag('trust-formatter', { type: 'boolean', default: false })` so it shows in `/help` and CLI completions. The runtime value comes from the env var (read by `shouldTrustFormatter()` at startup); the CLI flag is accepted but not auto-bound to the runtime — known limitation to avoid threading the flag value through every code path.

Default OFF; no behavior change for users not setting it.

## Lessons learned (gotchas)

1. **`input.edits[0].oldText`**, NOT `input.oldText`. Pi's edit tool takes an `edits` array. The first attempt of this extension silently no-op'd because of this.

2. **Empty `oldText` → infinite loop** in `findNormalizedMatches` via `indexOf("", pos)` always returning `pos` and `pos += ""` not advancing. Guard added: `if (!normalizedOldText || normalizedOldText.trim() === "") return [];`

3. **Custom renderers need in-place mutation.** Returning `{ content: [...] }` from `tool_result` creates a new object that bypasses renderers like `quiet-tools` which read `result.content` directly.

4. **Similarity was binary for 1-line blocks.** Original formula `1 - lineDistance/maxLines` gave similarity 0 or 1 when windowSize=1. Fixed by switching to char-level Levenshtein per line, averaged: `totalSim / windowSize`.

5. **`isError: false` makes quiet-tools collapse.** When `isError: true`, the renderer shows full output. Setting `false` triggers `COLLAPSED_TAIL_LINE_LIMIT` (10 lines), making the TUI compact while the model still gets everything.

6. **CRLF in `oldText` ≠ file CRLF.** Without normalizing `oldText` to LF before the literal match, models sending CRLF (or copy-pasting from Windows-style editors) get false-positive "wrong indentation" reports. Fixed in v0.6.1: `findLineAnchoredMatches(normalizedFileContent, oldTextLf)` — normalize `oldText` too.

7. **The surrender pattern dies at the auto-fix layer.** v0.6 made the error message better; v0.7 makes the error disappear for the most common case (uniform leading-space shift). The model never sees a block message and never falls back to `bash`/`python`.

8. **The literal matcher doesn't have a bug with multi-line edits — apparent failures are real inconsistencies in `oldText`.** During v0.12.0 implementation, edits to `extension.ts` and `package.json` were rejected with `fuzzy-match (similarity 1.00)` or `non-uniform-delta (mismatch at line N)`. Investigation showed the matcher (`countLineAnchoredMatches` / `findLineAnchoredMatches`), the cascade (`evaluateEdit`), and autofix (`tryAutofix`) all work correctly. The "bugs" were real inconsistencies in the test inputs — oldTexts where some lines had lost leading whitespace during encoding/pasting. The guard detected them precisely and reported the specific line number. Triage: when developing this extension (or any extension that uses `edit`), if the guard rejects an edit, `cat` the file and compare `oldText` byte-by-byte against the matching lines, paying special attention to leading whitespace per line. The hint `(mismatch at line N)` tells you exactly which line is off. The model sometimes sends oldTexts where only some lines have the right indent — that's a real model error, not a guard bug.

## Testing

Automated tests across 10 modules, plus an end-to-end script that exercises real files in `/tmp`:

```bash
pnpm test                # one-shot (uses node --experimental-strip-types)
pnpm test:watch          # watch mode
pnpm run test:e2e        # e2e: real files in /tmp, 9 scenarios (renamed from test:autofix)
pnpm run typecheck       # tsc --noEmit
```

Test layout (one file per source module, plus an e2e test that loads the extension via jiti):

```
tests/
├── _framework.ts                  # dependency-free assert/assertEq/assertMatch
├── run.ts                         # runner: imports all test modules in order
├── autofix.test.ts                # src/autofix.ts (pure delta + shift logic)
├── whitespace.test.ts             # src/whitespace.ts
├── block.test.ts                  # src/block.ts
├── matchers/
│   ├── literal.test.ts            # src/matchers/literal.ts
│   ├── normalized.test.ts         # src/matchers/normalized.ts
│   └── fuzzy.test.ts              # src/matchers/fuzzy.ts
├── evaluate.test.ts               # src/evaluate.ts (cascade)
├── format.test.ts                 # src/format/* (all output formats)
└── extension.test.ts              # src/extension.ts (e2e via jiti)

scripts/
└── test-autofix.ts                # e2e against real files in /tmp
```

Coverage includes the 3 surrender events observed in production logs (where models gave up on `edit` and switched to `python`/`bash` after 2-3 failed attempts), regression cases from v0.5.0/v0.6.0, batch semantics (1 of N edits fails → consolidated report), the autofix happy path (uniform shift) + decline paths (tabs, non-uniform, MAX_SANE_DELTA), and atomic-block invariant (no partial mutations when any edit is unfixable).

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

## Roadmap candidates (v0.8.0+)

- Adaptive threshold (stricter for long blocks, more lenient for short)
- Path exclusion config (e.g., skip `*.lock` files)
- New matchers: regex-based, AST-based
- Tab support (reintroduce with separate cascade branch; tabs would block + report instead of autofix)
- Metrics for false positives vs false negatives
- Telemetry opt-in for evaluating threshold defaults
