/**
 * formatCandidate: format the message for a single edit that resolved to
 * `unique-drift` or `fuzzy-match`. Wraps the correctly-indented block in a
 * fenced code block the model can copy verbatim as its next `oldText`.
 *
 * For the `indentation` kind, each line is prefixed with a `[Xsp]` / `[Xtb]`
 * marker showing its leading-whitespace count. The marker is descriptive
 * metadata — strip it to recover the file's actual line. This addresses the
 * failure mode observed in carta-qr (2024): the model had assumed the bullets
 * were indented at 2 spaces based on context, ignored the verbatim block we
 * returned, and re-submitted the same wrong indentation twice before falling
 * back to read+grep. The per-line marker makes the indent explicit per line
 * even when the block has mixed indents (e.g. some lines 0sp, others 4sp).
 */

import type { CandidateKind } from '../types.ts';
import { describeIndent } from '../whitespace.ts';

export function formatCandidate(startLine: number, lines: string[], kind: CandidateKind): string {
  const isIndent = kind === 'indentation';

  const header = isIndent
    ? `Error: Edit failed. Indentation in your oldText didn't match the file.`
    : `Error: Edit failed. Your oldText had a small difference from the file.`;

  // Per-line indent annotation only for the drift case. We keep the block
  // verbatim for fuzzy matches — those have character-level differences and
  // don't need whitespace disambiguation.
  const annotatedLines = isIndent ? lines.map((l) => `[${describeIndent(l)}] ${l}`) : lines;

  // Legend is always visible for the indentation case so the model can read
  // the markers without having to infer the meaning from prior knowledge.
  const legend = isIndent
    ? `sp = spaces, tb = tabs.\nThe \`[Xsp]\` / \`[Xtb]\` markers are descriptive metadata — strip them to get the file's original content.`
    : '';

  const last = startLine + lines.length - 1;
  const range = `Lines ${startLine}-${last}. `;
  const instruction = isIndent
    ? `${range}Use the lines below verbatim as your new oldText (after stripping the markers):`
    : 'Use this block as your new oldText in your next edit call:';

  const body = '```\n' + annotatedLines.join('\n') + '\n```';

  const parts = isIndent
    ? [header, '', legend, '', instruction, '', body]
    : [header, '', instruction, '', body];

  return parts.join('\n');
}