    /**
     * auto-fix: pure functions that attempt to silently correct indentation-only
     * edit failures by shifting the leading-space count of `newText` by the same
     * delta observed between the model's `oldText` and the file's matched block.
     *
     * Two modes (selected via `options.shiftNewText`):
     *
     *   - `shiftNewText: true` (default — used in non-trust / default mode):
     *     Full autofix. Compute a uniform delta from `oldText` vs the file
     *     block, then apply that delta to every line of `newText`. The edit
     *     becomes a no-op-as-far-as-indent, only changing the content the
     *     model actually wanted to change.
     *
     *   - `shiftNewText: false` (trust mode — formatter configured or env
     *     var set): Only correct `oldText` so native edit can find the block.
     *     Leave `newText` verbatim; the (internal or external) formatter is
     *     responsible for normalizing `newText` drift post-edit. The cascade
     *     has already verified the block exists; we don't need to compute a
     *     delta when we won't apply one. Most shift-related decline reasons
     *     (`non-uniform-delta`, `tab-in-newtext`, `delta-too-large`,
     *     `zero-delta`) become irrelevant; only `tab-in-file-block`,
     *     `line-count-mismatch`, and `missing-text` still decline.
     *
     * Design constraints (default mode):
     * - Spaces-only (no tabs). The project assumes files use leading spaces only.
     *   Tabs return null and fall through to the existing block+report path.
     * - Uniform shift required across all non-blank lines. If different lines have
     *   different deltas, the model's oldText doesn't represent a clean indent
     *   mistake — return null and let the existing path surface the error.
     * - Blank lines (whitespace-only lines) are ignored for delta computation and
     *   stay unchanged under shift. They don't carry semantic indent.
     * - newText must be free of tabs in leading whitespace. Applying a spaces-only
     *   shift to a line with leading tabs would write mixed-indent output back to
     *   a spaces-only file. We decline so the existing block+report path surfaces
     *   the error to the model instead of silently polluting the file.
     *
     * Decline reasons: every decline is categorized so the formatting layer can
     * surface a specific hint to the model instead of a generic "indentation
     * mismatch". This breaks the surrender-loop pattern observed in production
     * logs where the model keeps retrying the same edit without understanding
     * why it keeps failing.
     *
     * This module is pure: no I/O, no Pi imports. Trivial to unit-test.
     */

    import type { BlockExcerpt } from './block.ts';

    export type AutofixDeclineReason =
      | 'missing-text'
      | 'line-count-mismatch'
      | 'tab-in-oldtext'
      | 'tab-in-newtext'
      | 'tab-in-file-block'
      | 'non-uniform-delta'
      | 'zero-delta'
      | 'delta-too-large';

    /**
     * Optional context attached to a decline. Used by the formatter to render a
     * specific hint. Every field is optional — only the ones relevant to the
     * reason are populated.
     */
    export type AutofixDecline = {
      reason: AutofixDeclineReason;
      /** 0-indexed line where a tab was detected (tab-in-* reasons). */
      tabLine?: number;
      /** 0-indexed line where the delta differed from the first observed delta (non-uniform-delta). */
      deltaLine?: number;
      /** Line counts for line-count-mismatch. */
      mismatch?: { model: number; file: number };
      /** Absolute value of the largest observed delta when delta-too-large. */
      absDelta?: number;
    };

    export type AutofixResult = {
      /** File's actual lines verbatim (the cascade already guarantees this matches). */
      correctedOldText: string;
      /** newText with leading spaces shifted by `delta` (default mode) or verbatim (trust mode). */
      correctedNewText: string;
      /**
       * Signed spaces added per non-blank line (positive = deeper, negative = shallower).
       * In trust mode this is always 0 — the formatter normalizes newText drift post-edit.
       */
      delta: number;
      /** 1-indexed line range where the block sits in the file. */
      startLine: number;
      endLine: number;
    };

    export type AutofixOutcome =
      | { ok: true; result: AutofixResult }
      | { ok: false; decline: AutofixDecline };

    /**
     * Defense against bugs in our own shift computation. The cascade guarantees
     * the matched block is unique; under correct code the delta is whatever it is.
     * If `|delta| > MAX_SANE_DELTA`, something is off (e.g. counted whitespace
     * characters vs spaces) — refuse and fall through to the existing path.
     */
    const MAX_SANE_DELTA = 50;

    type EditInput = { oldText?: string; newText?: string };

    /**
     * Options for `tryAutofix`. Currently only one knob: `shiftNewText` controls
     * whether to apply a uniform leading-space shift to `newText` (default mode)
     * or leave it verbatim for the formatter to handle (trust mode).
     */
    export type TryAutofixOptions = {
      /**
       * When `true` (default), compute a delta and apply it to `newText` so
       * the edit becomes a pure content change. When `false`, only correct
       * `oldText` to the file block verbatim; `newText` passes through
       * unchanged and the (internal or external) formatter normalizes
       * newText drift post-edit. See module docstring for the full contract.
       */
      shiftNewText?: boolean;
    };

    export function tryAutofix(
      edit: EditInput,
      block: BlockExcerpt,
      options: TryAutofixOptions = {},
    ): AutofixOutcome {
      // Default: shift newText (full autofix). Trust modes pass `false` to
      // leave newText verbatim and let the formatter normalize post-edit.
      const shiftNewText = options.shiftNewText !== false;

      const oldText = edit.oldText;
      const newText = edit.newText;
      if (oldText === undefined || newText === undefined || oldText === '') {
        return { ok: false, decline: { reason: 'missing-text' } };
      }

      // Normalize CRLF on both sides; cascade normalizes the file but oldText/newText
      // come straight from the model and may have CRLF line endings.
      const normalizedOldText = oldText.replace(/\r\n/g, '\n');

      const modelLines = normalizedOldText.split('\n');
      const fileLines = block.lines;
      if (modelLines.length !== fileLines.length) {
        return {
          ok: false,
          decline: {
            reason: 'line-count-mismatch',
            mismatch: { model: modelLines.length, file: fileLines.length },
          },
        };
      }

      // correctedOldText is the file block verbatim. The cascade already matched
      // whitespace-stripped equality, so this IS what the file contains. We
      // always return it (both default and trust modes need it so native edit
      // can find the block).
      const correctedOldText = fileLines.join('\n');
      const startLine = block.startLine;
      const endLine = block.startLine + fileLines.length - 1;

      // (1) Trust-mode early return: only correct oldText, leave newText verbatim.
      // The (internal or external) formatter is responsible for normalizing
      // newText drift post-edit. The cascade has already verified the block
      // exists; we don't need to compute a delta when we won't apply one.
      // Only enforce the spaces-only assumption (tab-in-file-block) — the other
      // shift-related decline reasons are irrelevant when shiftNewText is false.
      if (!shiftNewText) {
        for (let i = 0; i < fileLines.length; i++) {
          if (hasLeadingTab(fileLines[i])) {
            return { ok: false, decline: { reason: 'tab-in-file-block', tabLine: i } };
          }
        }
        return {
          ok: true,
          result: {
            correctedOldText,
            correctedNewText: newText, // unchanged; formatter normalizes
            delta: 0, // informational: no shift applied
            startLine,
            endLine,
          },
        };
      }

      // (2) Default mode: compute a uniform delta from non-blank pairs of
      // lines. Tabs in either side disqualify the autofix — we don't handle them.
      let delta: number | null = null;
      for (let i = 0; i < modelLines.length; i++) {
        const m = modelLines[i];
        const f = fileLines[i];
        if (m.trim() === '' && f.trim() === '') continue;
        if (m.trim() === '' || f.trim() === '') continue;
        if (hasLeadingTab(m)) {
          return { ok: false, decline: { reason: 'tab-in-oldtext', tabLine: i } };
        }
        if (hasLeadingTab(f)) {
          return { ok: false, decline: { reason: 'tab-in-file-block', tabLine: i } };
        }

        const d = countLeadingSpaces(f) - countLeadingSpaces(m);
        if (delta === null) {
          delta = d;
        } else if (delta !== d) {
          return { ok: false, decline: { reason: 'non-uniform-delta', deltaLine: i } };
        }
      }
      if (delta === null || delta === 0) {
        return { ok: false, decline: { reason: 'zero-delta' } };
      }
      if (Math.abs(delta) > MAX_SANE_DELTA) {
        return { ok: false, decline: { reason: 'delta-too-large', absDelta: Math.abs(delta) } };
      }

      // (3) Apply shift to newText per-line; blank lines stay as-is.
      const normalizedNewText = newText.replace(/\r\n/g, '\n');

      // Decline if any line of newText has a tab in its leading whitespace.
      // Applying a spaces-only delta to such a line would produce mixed-indent
      // output (the shift inserts spaces but the tab remains), polluting the
      // spaces-only file silently. Surfacing the error via the block+report path
      // is safer than writing mixed indent.
      const newTextLines = normalizedNewText.split('\n');
      for (let i = 0; i < newTextLines.length; i++) {
        if (hasLeadingTab(newTextLines[i])) {
          return { ok: false, decline: { reason: 'tab-in-newtext', tabLine: i } };
        }
      }

      const correctedNewText = newTextLines.map((line) => shiftLeadingSpaces(line, delta)).join('\n');

      return {
        ok: true,
        result: {
          correctedOldText,
          correctedNewText,
          delta,
          startLine,
          endLine,
        },
      };
    }

    export function countLeadingSpaces(line: string): number {
      const m = line.match(/^( *)/);
      return m ? m[1].length : 0;
    }

    export function hasLeadingTab(line: string): boolean {
      const ws = line.match(/^[ \t]+/);
      return ws?.[0]?.includes('\t') ?? false;
    }

    export function shiftLeadingSpaces(line: string, delta: number): string {
      if (line.trim() === '') return line;
      const leading = countLeadingSpaces(line);
      return ' '.repeat(Math.max(0, leading + delta)) + line.slice(leading);
    }


