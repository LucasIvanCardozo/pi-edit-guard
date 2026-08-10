/**
 * Whitespace-normalized exact matching.
 *
 * Strips leading spaces/tabs from each line of both the file and the
 * `oldText`, then looks for exact matches. Used to detect pure indentation
 * drift: the model wrote the right code but with the wrong number of
 * leading spaces.
 *
 * Defensive: empty `normalizedOldText` returns `[]` because `indexOf("", pos)`
 * always returns `pos` and `pos += ""` never advances, causing an infinite
 * loop.
 */

import { normalizeText } from '../whitespace.ts';

export function findNormalizedMatches(
  fileContent: string,
  normalizedOldText: string,
): Array<{ startLine: number; matchedLines: string[] }> {
  if (!normalizedOldText || normalizedOldText.trim() === '') return [];

  const fileLines = fileContent.split('\n');
  const normalizedFileLines = fileLines.map((l) => l.replace(/^[ \t]+/, ''));
  const normalizedFile = normalizedFileLines.join('\n');

  const oldTextLineCount = normalizedOldText.split('\n').length;
  const matches: Array<{ startLine: number; matchedLines: string[] }> = [];

  let pos = 0;
  for (;;) {
    pos = normalizedFile.indexOf(normalizedOldText, pos);
    if (pos === -1) break;
    const before = normalizedFile.substring(0, pos);
    const startLine = before.split('\n').length - 1;
    const matchedLines = fileLines.slice(startLine, startLine + oldTextLineCount);
    matches.push({ startLine: startLine + 1, matchedLines });
    pos += normalizedOldText.length;
  }

  return matches;
}

export { normalizeText };
