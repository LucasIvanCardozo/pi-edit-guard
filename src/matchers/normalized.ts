/**
 * Whitespace-normalized exact matching.
 *
 * Strips leading spaces/tabs from each line of both the file and the
 * `oldText`, then looks for **exact line matches** (not substring matches).
 * Used to detect pure indentation drift: the model wrote the right code but
 * with the wrong number of leading spaces.
 *
 * The previous implementation used `String.indexOf` on the joined normalized
 * text. That had two bugs that combined into a frustrating loop pattern:
 *
 *   1. **Substring false positives.** `indexOf('const head')` matches both
 *      `const head = ...` AND `const header = ...`. The matcher would
 *      return `ambiguous-normalized` with one real match and one substring
 *      match. The model couldn't tell which one was the real target and
 *      entered a retry loop.
 *
 *   2. **Cross-line false positives.** A needle like `foo\nbar` could
 *      match `foo\nbar` at the end of one line plus `bar` at the start of
 *      the next line, even when those two lines were semantically
 *      unrelated. Same root cause: `indexOf` on joined text is substring
 *      matching, not line-anchored line matching.
 *
 * The fix: iterate per line. For each file line whose normalized form
 * EQUALS the needle's first line, check whether the next N-1 lines also
 * match line-for-line. This preserves the "tolerates indent drift"
 * semantics while rejecting substring and cross-line false matches.
 *
 * Defensive: empty `normalizedOldText` returns `[]` because scanning with
 * an empty needle would match every line.
 */

import { normalizeText } from '../whitespace.ts';

export function findNormalizedMatches(
  fileContent: string,
  normalizedOldText: string,
): Array<{ startLine: number; matchedLines: string[] }> {
  if (!normalizedOldText || normalizedOldText.trim() === '') return [];

  const fileLines = fileContent.split('\n');
  const normalizedFileLines = fileLines.map((l) => l.replace(/^[ \t]+/, ''));
  const needleLines = normalizedOldText.split('\n');

  // Empty lines on either side are not a match: a model whose `oldText`
  // is shorter than the file block shouldn't match here. The cascade
  // already has ok-literal for that. We reject empty FIRST or LAST line
  // of the needle (likely truncated/malformed), but allow blank lines
  // in the middle — those are legitimate separators between groups of
  // statements (e.g. a function body with a blank line between const
  // groups, which is a very common pattern).
  if (needleLines[0] === '' || needleLines[needleLines.length - 1] === '') return [];

  const needleLineCount = needleLines.length;
  const matches: Array<{ startLine: number; matchedLines: string[] }> = [];

  // Scan every file line as a potential match start. O(fileLines * needleLen)
  // worst case but fine for typical files.
  for (let i = 0; i <= normalizedFileLines.length - needleLineCount; i++) {
    let match = true;
    for (let j = 0; j < needleLineCount; j++) {
      if (normalizedFileLines[i + j] !== needleLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      matches.push({
        startLine: i + 1,
        matchedLines: fileLines.slice(i, i + needleLineCount),
      });
    }
  }

  return matches;
}

export { normalizeText };
