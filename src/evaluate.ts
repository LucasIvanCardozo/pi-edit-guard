/**
 * Cascade evaluation: pure functions that take a file content and one or
 * more `oldText` blocks and produce a structured verdict per edit.
 *
 * The cascade is:
 *   1. Literal line-anchored count
 *   2. Whitespace-normalized exact match
 *   3. Char-level Levenshtein fuzzy match
 *
 * Each step can either resolve the edit (ok, drift, fuzzy, ambiguous) or
 * fall through to the next step.
 */

import { type BlockExcerpt, toBlockExcerpt } from './block.ts';
import {
  findFuzzyMatches,
  findLineAnchoredMatches,
  findNormalizedMatches,
} from './matchers/index.ts';
import type { EditEvaluation } from './types.ts';
import { normalizeText } from './whitespace.ts';

export function evaluateEdit(
  fileContent: string,
  oldText: string,
  threshold: number,
  maxExamples: number,
): EditEvaluation {
  const normalizedFileContent = fileContent.replace(/\r\n/g, '\n');
  const oldTextLf = oldText.replace(/\r\n/g, '\n');
  const normalizedOldText = normalizeText(oldTextLf);

  // Step 1: literal line-anchored count. Use the same scan that produces
  // block excerpts so the >1 case doesn't re-scan the file.
  const literal = findLineAnchoredMatches(normalizedFileContent, oldTextLf);

  if (literal.matches.length === 1) {
    return { kind: 'ok-literal' };
  }

  if (literal.matches.length > 1) {
    return {
      kind: 'ambiguous-literal',
      count: literal.matches.length,
      examples: literal.matches.slice(0, maxExamples).map(toBlockExcerpt),
    };
  }

  // Step 2: whitespace-normalized exact match
  if (normalizedOldText.length > 0) {
    const normalizedMatches = findNormalizedMatches(normalizedFileContent, normalizedOldText);
    if (normalizedMatches.length === 1) {
      return { kind: 'unique-drift', block: toBlockExcerpt(normalizedMatches[0]) };
    }
    if (normalizedMatches.length > 1) {
      return {
        kind: 'ambiguous-normalized',
        count: normalizedMatches.length,
        examples: normalizedMatches.slice(0, maxExamples).map(toBlockExcerpt),
      };
    }
  }

  // Step 3: fuzzy diff-based
  const fuzzyMatches = findFuzzyMatches(normalizedFileContent, oldText, threshold);
  if (fuzzyMatches.length === 1) {
    return {
      kind: 'fuzzy-match',
      block: toBlockExcerpt(fuzzyMatches[0]),
      similarity: fuzzyMatches[0].similarity,
    };
  }
  if (fuzzyMatches.length > 1) {
    return {
      kind: 'ambiguous-fuzzy',
      count: fuzzyMatches.length,
      examples: fuzzyMatches.slice(0, maxExamples).map(toBlockExcerpt),
    };
  }

  // Nothing above threshold: find best match for hint
  const allCandidates = findFuzzyMatches(normalizedFileContent, oldText, 0).sort(
    (a, b) => b.similarity - a.similarity,
  );
  const best = allCandidates[0];
  const bestSimilarity = best?.similarity ?? 0;
  const bestBlock: BlockExcerpt | null = best ? toBlockExcerpt(best) : null;
  return { kind: 'no-match', bestSimilarity, bestBlock };
}

export function evaluateBatch(
  fileContent: string,
  edits: Array<{ oldText?: string }>,
  threshold: number,
  maxExamples: number,
): EditEvaluation[] {
  return edits.map((edit) => {
    const oldText = edit?.oldText ?? '';
    if (!oldText) {
      // Empty oldText: native edit's own check handles it; treat as no-match.
      return { kind: 'no-match', bestSimilarity: 0, bestBlock: null };
    }
    return evaluateEdit(fileContent, oldText, threshold, maxExamples);
  });
}
