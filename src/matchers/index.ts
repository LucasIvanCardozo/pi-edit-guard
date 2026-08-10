/**
 * Matchers barrel.
 *
 * Re-exports the three matchers for ergonomic imports:
 *
 *   import { findNormalizedMatches, findFuzzyMatches } from "../matchers";
 *
 * No logic lives here. Pure re-exports only.
 */

export { findFuzzyMatches } from './fuzzy.ts';
export {
  countLineAnchoredMatches,
  findLineAnchoredMatches,
} from './literal.ts';
export { findNormalizedMatches } from './normalized.ts';
