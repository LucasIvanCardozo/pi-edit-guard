/**
 * formatCandidate: format the message for a single edit that resolved to
 * `unique-drift` or `fuzzy-match`. Wraps the correctly-indented block in a
 * fenced code block the model can copy verbatim as its next `oldText`.
 */

import type { CandidateKind } from '../types.ts';
import { describeIndent } from '../whitespace.ts';

export function formatCandidate(_startLine: number, lines: string[], kind: CandidateKind): string {
  const reason =
    kind === 'indentation'
      ? 'Your oldText had wrong indentation'
      : 'Your oldText had a small difference from the file';

  const header = `Error: Edit failed. ${reason}.\n`;
  const instruction = 'Use this block as your new oldText in your next edit call:\n';

  const labels = lines.map(describeIndent);
  const hasSpaces = labels.some((l) => l.includes('sp'));
  const hasTabs = labels.some((l) => l.includes('tb'));
  const legend = hasSpaces && hasTabs ? 'sp = spaces, tb = tabs\n' : '';

  const body = '```\n' + lines.join('\n') + '\n```';

  const legendSection = legend ? legend + '\n' : '';
  return header + legendSection + instruction + '\n' + body;
}
