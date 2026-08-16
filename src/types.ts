/**
 * Shared types for the cascade.
 *
 * `EditEvaluation` is the verdict of the cascade for a single `oldText`
 * against the file content. The formatting layer turns these into
 * user-facing messages.
 */

import type { AutofixDecline } from './autofix.ts';
import type { BlockExcerpt } from './block.ts';

export type { BlockExcerpt };

/**
 * Optional decline context attached to a `unique-drift` evaluation when the
 * autofix path declined to apply. Only present on `unique-drift`; the
 * formatter uses it to surface a specific hint instead of a generic
 * "indentation mismatch" message.
 */
export type EditEvaluation =
  | { kind: 'ok-literal' }
  | { kind: 'unique-drift'; block: BlockExcerpt; decline?: AutofixDecline }
  | { kind: 'fuzzy-match'; block: BlockExcerpt; similarity: number }
  | { kind: 'ambiguous-literal'; count: number; examples: BlockExcerpt[] }
  | { kind: 'ambiguous-normalized'; count: number; examples: BlockExcerpt[] }
  | { kind: 'ambiguous-fuzzy'; count: number; examples: BlockExcerpt[] }
  | { kind: 'no-match'; bestSimilarity: number; bestBlock: BlockExcerpt | null }
  | { kind: 'no-op'; reason: 'identical-text' };

export type CandidateKind = 'indentation' | 'fuzzy';
