/**
 * formatCandidate: format the message for a single edit that resolved to
 * `fuzzy-match` or `unique-drift` (when the latter could not be auto-fixed).
 *
 * For `fuzzy-match`: small character-level difference. The model sees the
 * file's lines verbatim plus a similarity score and copies them as its new
 * oldText.
 *
 * For `unique-drift`: pure indentation mismatch that the autofix path could
 * not silently correct (e.g. tabs in the file, non-uniform shift, defensive
 * cap exceeded). The model sees the file's actual lines and copies them
 * verbatim. Indent marker `[Xsp]` annotation is omitted in v0.7+ — the
 * failed auto-fix already gave the model a strong signal about why; the
 * verbatim block is the actionable copy.
 */

import type { CandidateKind } from '../types.ts';

export function formatCandidate(startLine: number, lines: string[], kind: CandidateKind): string {
  if (kind === 'fuzzy') {
    return formatFuzzy(startLine, lines);
  }
  if (kind === 'indentation') {
    return formatIndentation(startLine, lines);
  }
  return '';
}

function formatFuzzy(startLine: number, lines: string[]): string {
  const header = `Error: Edit failed. Your oldText had a small difference from the file.`;
  const last = startLine + lines.length - 1;
  const range = `Lines ${startLine}-${last}. `;
  const instruction = `${range}Use this block verbatim as your new oldText:`;
  const body = '```\n' + lines.join('\n') + '\n```';
  return [header, '', instruction, '', body].join('\n');
}

function formatIndentation(startLine: number, lines: string[]): string {
  const header = `Error: Edit failed. Indentation in your oldText didn't match the file.`;
  const last = startLine + lines.length - 1;
  const range = `Lines ${startLine}-${last}. `;
  const instruction = `${range}Use these lines verbatim as your new oldText (including leading whitespace):`;
  const body = '```\n' + lines.join('\n') + '\n```';
  return [header, '', instruction, '', body].join('\n');
}
