# pi-edit-guard

Pi extension that wraps the native `edit` tool with **indentation-drift recovery** and **uniqueness enforcement**.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends a `oldText` that doesn't match the file's actual indentation, and the edit fails with a generic "Could not find" error. The model then has to either re-read the file (cost) or give up.

`pi-edit-guard` catches these failures and returns the most probable target block with **explicit indentation annotations** so the model can retry correctly.

## Install

```bash
pi install npm:@lucascardozo/pi-edit-guard
```

## What it does

### Two-layer protection

**Layer 1 — `tool_call` (before native edit runs)**
- Counts how many literal occurrences of `oldText` exist in the file
- If `> 1` occurrences → blocks the tool with our message instead of the native "Found N occurrences, please provide more context"
- If `1` or `0` → passes through to native edit normally

**Layer 2 — `tool_result` (when native edit fails)**
- When native edit fails because `oldText` is not found exactly, runs a cascade:
  1. **Whitespace-normalized match** — strips leading spaces/tabs per line, looks for exact match
     - 1 unique match → return the block with the file's real indentation annotated
     - Multiple matches → "ambiguous, re-read the file"
     - 0 matches → continue to step 2
  2. **Char-level fuzzy match** — Levenshtein per line, averaged across the block
     - 1 candidate above threshold (default 0.90) → return it with similarity score
     - Multiple above threshold → "ambiguous, re-read"
     - 0 above threshold → "no match" with best-match hint

### Mutates `event.content` in-place

Other extensions (e.g. `gentle-pi`'s `quiet-tools`) register custom renderers that read `result.content` directly. Returning a `{ content: [...] }` patch from `tool_result` would create a new object that the custom renderer would never see.

`pi-edit-guard` mutates `event.content` in-place so custom renderers pick up the enriched message. It also sets `isError: false` so renderers like `quiet-tools` collapse long output via their `COLLAPSED_TAIL_LINE_LIMIT` (the model still receives the full content — only the visual collapses).

## Output format

Compact and minimal-token:

```
Most similar block at lines 43-49 (similarity 0.99):
  8sp    L45           if (item % 2 === 0) {
  10sp   L46             return acc + item * 2;
  8sp    L47           } else {
  10sp   L48             return acc + item;
  8sp    L49           }

Use as oldText.
```

Indent descriptors:
- `4sp` → 4 spaces
- `2tb` → 2 tabs
- `2sp+1tb` → mixed
- `-` → no indent

## Configuration

| Env var | Default | Range | Effect |
|---|---|---|---|
| `PI_EDIT_GUARD_THRESHOLD` | `0.90` | `0..1` | Similarity threshold for fuzzy matches (Level B). Lower = more permissive. |

Set before launching Pi:

```bash
PI_EDIT_GUARD_THRESHOLD=0.85 pi
```

## What it does NOT do

- It does **not** write to files. The model must retry the edit itself.
- It does **not** auto-fix indentation. The model decides what to do with the suggestion.
- It does **not** change the `bash`, `write`, `read`, or any other tool — only `edit`.

## Compatibility

- **Pi**: 0.84+
- **Node**: 20+ (uses native `node:fs/promises`)
- **TypeScript**: source-only (Pi loads via jiti, no build step required)

## Tested alongside

- `gentle-pi` v2.1.2 with `quiet-tools.ts` enabled — works correctly, custom renderer respects the mutation

## License

MIT