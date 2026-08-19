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
export { formatNoMatchMessage } from './no-match.ts';

// Formatter integration (v0.12.0): config, runner, and tool_result rewriter.
// Adapted from pi-code-formatter by losnappas (MIT).
export {
  findFormatter,
  loadConfig,
  mergeConfigs,
  resolveFormatters,
  compilePattern,
} from '../formatter-config.ts';
export type {
  AutoformatConfig,
  ResolvedFormatter,
} from '../formatter-config.ts';
export { runFormatter } from './runner.ts';
export type { FormatterRunResult } from './runner.ts';
export { generateRewriteResult } from './tool-result-rewriter.ts';
export type { RewriteResult } from './tool-result-rewriter.ts';