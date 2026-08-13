/**
 * Consolidated report formatters.
 *
 * `formatEvaluationSection` produces one numbered section per edit in a
 * batch. `formatConsolidatedReport` is the orchestrator: takes the
 * evaluation array, produces per-section messages, and joins them with a
 * header ("Edit guard: N of M edits have issues") and a closing
 * instruction.
 */

import type { EditEvaluation } from '../types.ts';
import { formatAmbiguousMessage } from './ambiguous.ts';
import { formatCandidate } from './candidate.ts';
import { formatNoMatchMessage } from './no-match.ts';

export function formatEvaluationSection(
  evaluation: EditEvaluation,
  editIndex: number,
  threshold: number,
  hintMin: number,
): string {
  const header = `Edit ${editIndex}:`;
  switch (evaluation.kind) {
    case 'ok-literal':
      return '';
    case 'unique-drift':
      return `${header} ${formatCandidate(evaluation.block.startLine, evaluation.block.lines, 'indentation', evaluation.decline)}`;
    case 'fuzzy-match':
      return (
        `${header} ${formatCandidate(evaluation.block.startLine, evaluation.block.lines, 'fuzzy')}\n` +
        `(similarity ${evaluation.similarity.toFixed(2)})`
      );
    case 'ambiguous-literal':
    case 'ambiguous-normalized':
      return `${header} ${formatAmbiguousMessage(evaluation.count, evaluation.examples, 1.0)}`;
    case 'ambiguous-fuzzy':
      return `${header} ${formatAmbiguousMessage(evaluation.count, evaluation.examples, threshold)}`;
    case 'no-match':
      return `${header} ${formatNoMatchMessage(evaluation.bestSimilarity, threshold, evaluation.bestBlock, hintMin)}`;
  }
}

export function formatConsolidatedReport(
  evaluations: EditEvaluation[],
  total: number,
  threshold: number,
  hintMin: number,
): string | null {
  const sections: string[] = [];
  for (let i = 0; i < evaluations.length; i++) {
    const section = formatEvaluationSection(evaluations[i], i + 1, threshold, hintMin);
    if (section) sections.push(section);
  }
  if (sections.length === 0) return null;

  const failed = sections.length;
  const head = `Edit guard: ${failed} of ${total} edit${total === 1 ? '' : 's'} ${failed === 1 ? 'has' : 'have'} issues.`;
  const tail =
    `\n\nFix the issues above and re-submit the entire batch. ` +
    `Edits already passing will be re-evaluated with the new file state.`;

  return `${head}\n\n${sections.join('\n\n')}${tail}`;
}
