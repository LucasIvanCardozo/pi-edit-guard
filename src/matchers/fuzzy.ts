/**
 * Char-level Levenshtein fuzzy matching.
 *
 * Slides a window of `oldText`'s line count over the file, computing
 * per-line character similarity (1 - Levenshtein/maxLen), and averaging
 * across the window. Returns candidates whose average similarity meets
 * `threshold`.
 *
 * Used to detect small character differences: typos, missing semicolons,
 * wrong identifier names.
 */

import { stripLeadingWhitespace } from '../whitespace.ts';

function levenshteinDistance<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (equals(a[i - 1], b[j - 1])) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function lineCharSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a && !b) return 1;
  const dist = levenshteinDistance(a.split(''), b.split(''), (x, y) => x === y);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

export function findFuzzyMatches(
  fileContent: string,
  oldText: string,
  threshold: number,
): Array<{ startLine: number; matchedLines: string[]; similarity: number }> {
  const fileLines = fileContent.split('\n');
  const oldTextLines = oldText.split('\n').map(stripLeadingWhitespace);
  const windowSize = oldTextLines.length;

  if (windowSize === 0 || windowSize > fileLines.length) return [];

  const candidates: Array<{
    startLine: number;
    matchedLines: string[];
    similarity: number;
  }> = [];

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines.slice(i, i + windowSize).map(stripLeadingWhitespace);
    let totalSim = 0;
    for (let j = 0; j < windowSize; j++) {
      totalSim += lineCharSimilarity(oldTextLines[j], window[j]);
    }
    const similarity = totalSim / windowSize;

    if (similarity >= threshold) {
      candidates.push({
        startLine: i + 1,
        matchedLines: fileLines.slice(i, i + windowSize),
        similarity,
      });
    }
  }

  return candidates;
}
