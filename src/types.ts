/**
 * Shared types for the cascade.
 *
 * `EditEvaluation` is the verdict of the cascade for a single `oldText`
 * against the file content. The formatting layer turns these into
 * user-facing messages.
 */

import type { BlockExcerpt } from './block.ts';

export type { BlockExcerpt };

export type EditEvaluation =
  | { kind: 'ok-literal' }
  | { kind: 'unique-drift'; block: BlockExcerpt }
  | { kind: 'fuzzy-match'; block: BlockExcerpt; similarity: number }
  | { kind: 'ambiguous-literal'; count: number; examples: BlockExcerpt[] }
  | { kind: 'ambiguous-normalized'; count: number; examples: BlockExcerpt[] }
  | { kind: 'ambiguous-fuzzy'; count: number; examples: BlockExcerpt[] }
  | { kind: 'no-match'; bestSimilarity: number; bestBlock: BlockExcerpt | null };

export type CandidateKind = 'indentation' | 'fuzzy';
