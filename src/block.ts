/**
 * Block excerpt type and conversion helpers.
 *
 * The matcher algorithms return `{ startLine, matchedLines }` because that's
 * their natural shape. The public-facing API uses `{ startLine, lines }` for
 * brevity. `toBlockExcerpt` bridges the two.
 */

export type BlockExcerpt = {
  startLine: number;
  lines: string[];
};

export function toBlockExcerpt(m: { startLine: number; matchedLines: string[] }): BlockExcerpt {
  return { startLine: m.startLine, lines: m.matchedLines };
}
