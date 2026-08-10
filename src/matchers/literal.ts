/**
 * Literal line-anchored substring matching.
 *
 * Counts occurrences of `needle` in `haystack` where the match must start at
 * the beginning of a line (or at position 0). This matches the semantics of
 * the native `edit` tool: a plain `split().length - 1` substring count is
 * wrong because e.g. "  return 1;" is a substring of "    return 1;" but is
 * not the same line.
 */

export function countLineAnchoredMatches(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    pos = haystack.indexOf(needle, pos);
    if (pos === -1) break;
    if (pos === 0 || haystack[pos - 1] === '\n') {
      count++;
    }
    pos += needle.length;
  }
  return count;
}

export function findLineAnchoredMatches(
  haystack: string,
  needle: string,
): {
  count: number;
  matches: Array<{ startLine: number; matchedLines: string[] }>;
} {
  if (!needle) return { count: 0, matches: [] };

  const fileLines = haystack.split('\n');
  const needleLineCount = needle.split('\n').length;
  const matches: Array<{ startLine: number; matchedLines: string[] }> = [];

  let pos = 0;
  for (;;) {
    pos = haystack.indexOf(needle, pos);
    if (pos === -1) break;
    if (pos === 0 || haystack[pos - 1] === '\n') {
      const before = haystack.substring(0, pos);
      const startLine = before.split('\n').length - 1;
      matches.push({
        startLine: startLine + 1,
        matchedLines: fileLines.slice(startLine, startLine + needleLineCount),
      });
    }
    pos += needle.length;
  }

  return { count: matches.length, matches };
}
