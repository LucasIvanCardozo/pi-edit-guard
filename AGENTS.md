# AGENTS.md

Quick context for working on `@lucascardozo/pi-edit-guard`.

## What this is

Pi extension that wraps the native `edit` tool with two-layer protection:

1. **`tool_call` hook** — intercepts before native edit runs. Blocks when:
   - `oldText` appears literally > 1 times in the file (ambiguous match), OR
   - `oldText` has 0 literal occurrences but exactly 1 normalized match (unambiguous indentation drift). The guard returns the correctly-indented block as the block reason so the model gets a clear actionable error instead of looping.
2. **`tool_result` hook** — fallback that catches native edit failures that escape Layer 1 (e.g., 0 literal + 0 normalized matches). Runs the same normalized/exact + fuzzy cascade to enrich the error with the most probable target block.

Fixes the most common LLM failure mode in code editing: the model counts spaces wrong, sends a non-matching `oldText`, and the edit fails with a generic error.

## Status

- **v0.1.0 published** to npm as `@lucascardozo/pi-edit-guard`
- Install: `pi install npm:@lucascardozo/pi-edit-guard`
- Repo: https://github.com/LucasIvanCardozo/pi-edit-guard
- License: MIT

## File layout

Single-file extension (`index.ts`, ~384 lines). No build step. Pi loads via jiti.

```
index.ts          the extension
package.json      name, pi manifest, env config
README.md         install + usage
LICENSE           MIT
AGENTS.md         this file
```

## Architecture

### Tool call hook (intercepts BEFORE native edit)

```ts
pi.on("tool_call", async (event) => {
  if (event.toolName !== "edit") return;
  const input = event.input as {
    path?: string;
    edits?: Array<{ oldText?: string }>;
  };
  const oldText = input?.edits?.[0]?.oldText;  // ← NOT input.oldText
  if (!filePath || !oldText) return;
  const content = await readFile(filePath, "utf-8");
  const occurrences = content.split(oldText).length - 1;  // literal substring match

  if (occurrences > 1) {
    return { block: true, reason: formatMultipleMatches(occurrences, 1.0) };
  }

  if (occurrences === 0) {
    // 0 ocurrencias: chequear si es drift de indentación (match normalized)
    const normalizedMatches = findNormalizedMatches(content, normalizeText(oldText));
    if (normalizedMatches.length === 1) {
      return { block: true, reason: formatCandidate(m.startLine, m.matchedLines, 1.0) };
    }
  }
  // 1 ocurrencia (único, deja pasar al nativo)
  // 0 ocurrencias sin match normalized (deja pasar al nativo, tool_result se encarga)
});
```

### Tool result hook (catches native edit failures)

Cascade algorithm:

1. **Level A — whitespace-normalized exact match** (strip leading spaces/tabs per line):
   - 1 unique match → return it with similarity 1.00
   - > 1 → "ambiguous, re-read"
   - 0 → advance to Level B

2. **Level B — char-level Levenshtein per line, averaged across block**:
   - 1 candidate above threshold (default 0.90) → return with similarity score
   - > 1 → "ambiguous, re-read"
   - 0 → "no match" with best-score hint

### CRITICAL: mutate `event.content` in-place, don't return patch

```ts
function mutateToolResult(event, newText, isError) {
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

The block is wrapped in a Markdown fenced code block so the model can copy it verbatim as its new `oldText`. The block itself has no annotation prefixes — the indentation shown is the file's actual indentation.

```
Error: Most similar block to edit at lines 43-49.
Your oldText had wrong indentation. Use this block as your new oldText:

```
        if (item % 2 === 0) {
          return acc + item * 2;
        } else {
          return acc + item;
        }
```

Use this block as your new oldText in your next edit call.
```

**Indent descriptors** (used internally for the `sp = spaces, tb = tabs` legend when the block has mixed indentation):
- `4sp` → 4 spaces
- `2tb` → 2 tabs
- `2sp+1tb` → mixed
- `-` → no indent

The legend only appears when the block has both spaces and tabs in different lines:

```
Error: Most similar block to edit at lines 43-49.
sp = spaces, tb = tabs

Your oldText had wrong indentation. Use this block as your new oldText:

```
...
```

Use this block as your new oldText in your next edit call.
```

### Message rules (no redundancies)

- **DON'T** include `Edit failed: oldText not found in /path` — path is already in the tool header, "oldText not found" is implied by the rest
- **DON'T** include `Retry using this exact text as oldText, preserving the indentation shown` — too verbose, the model knows what to do
- **DO** start directly with the actionable info (`Error: Most similar block at...`, `Found N similar blocks...`, `No sufficiently similar block...`)
- End candidate messages with `Use this block as your new oldText in your next edit call.`
- The block is shown as a fenced code block (no `sp`/`tb` prefixes per line) so the model can copy it verbatim.
- The sub-header distinguishes two cases:
  - `Your oldText had wrong indentation.` (normalized match: pure indentation drift)
  - `Your oldText had a small difference from the file. The closest matching block is:` (fuzzy match: typos, small character differences)

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

## Manual testing

No automated tests yet. To verify each scenario manually:

```bash
# Create test fixture with multiple indentation styles
cat > test.ts <<'EOF'
function foo() {
    const x = 1;
  if (x) {
        return x;
  }
}
EOF

# Test 1: indent drift → should suggest with real indent
# Test 2: fuzzy typo (1 char) → should suggest with similarity ~0.95+
# Test 3: ambiguous (same block twice) → "Found N similar blocks"
# Test 4: no match → "best match: 0.XX, below threshold"
# Test 5: hook blocks on > 1 literal occurrences (tool_call layer)
```

Watch `/tmp/edit-guard-loaded.log` for session confirmation, and check the TUI render to verify `quiet-tools` collapses the output.

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

## Roadmap candidates (v0.2.0)

- Adaptive threshold (stricter for long blocks, more lenient for short)
- Automated tests (vitest? custom harness?)
- Path exclusion config (e.g., skip `*.lock` files)
- Better metrics for false positives vs false negatives