/**
 * Formatting layer barrel.
 *
 * Each submodule has one responsibility. Consumers should import from
 * `src/format/` (this file) for the public surface, or directly from
 * the submodule for internal use.
 */

export {
  formatAmbiguousMessage,
  formatBlockPreview,
  formatExamples,
} from './ambiguous.ts';
export { formatCandidate } from './candidate.ts';
export {
  formatConsolidatedReport,
  formatEvaluationSection,
} from './consolidated.ts';
export type { FormatterResult } from './formatter.ts';
export { runFormatter } from './formatter.ts';
export { formatNoMatchMessage } from './no-match.ts';
