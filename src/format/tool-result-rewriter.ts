/**
 * Tool result rewriter: recompute `patch` and `diff` for an Edit tool result
 * after an external formatter has rewritten the file.
 *
 * The trick from pi-code-formatter: the diff the model sees is from the
 * file's state BEFORE the edit (`originalContent`) to the file's state AFTER
 * the formatter ran (`formattedContent`). Never the intermediate drift state.
 * This way, if the model wrote newText with the wrong indent, the formatter
 * fixes it and the model sees the atomic final state.
 *
 * Adapted from pi-code-formatter
 * (https://github.com/losnappas/pi-code-formatter) by losnappas. MIT License.
 *
 * `generateUnifiedPatch` produces a standard unified-diff patch (the same
 * format Pi's built-in edit tool uses internally). `generateDiffString`
 * produces a display-oriented diff with line numbers and context, plus the
 * first changed line number for editor navigation.
 */

import * as Diff from "diff";

export interface RewriteResult {
  details: {
    patch: string;
    diff: string;
    firstChangedLine?: number;
  };
}

/**
 * Generate a standard unified patch string. Mirrors what Pi's built-in edit
 * tool does internally — same arguments to `Diff.createTwoFilesPatch`.
 */
function generateUnifiedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  return Diff.createTwoFilesPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 4, headerOptions: Diff.FILE_HEADERS_ONLY },
  );
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the
 * new file).
 */
function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;
        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
          // (Note: this branch differs slightly from upstream — original had
          // newLineNum only incremented when raw was fully shown. Kept
          // incremental for consistency with the leading+trailing branch.)
        }
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

/**
 * Compute the rewritten `details` object (patch/diff/firstChangedLine) for a
 * tool result that needs to reflect `originalContent → formattedContent`.
 *
 * Pure: no I/O, no side effects. Caller is responsible for capturing the
 * original content before the edit and reading the formatted content after.
 */
export function generateRewriteResult(
  filePath: string,
  originalContent: string,
  formattedContent: string,
): RewriteResult {
  const patch = generateUnifiedPatch(filePath, originalContent, formattedContent);
  const { diff, firstChangedLine } = generateDiffString(originalContent, formattedContent);
  return {
    details: {
      patch,
      diff,
      firstChangedLine,
    },
  };
}