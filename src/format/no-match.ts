/**
 * No-match message formatter.
 *
 * Shown when no candidate reaches the fuzzy threshold. Includes the best
 * similarity score and, when above the hint minimum, the closest block as a
 * preview. Below the hint minimum the block is omitted to avoid
 * misleading the model with a too-distant suggestion.
 */

import type { BlockExcerpt } from '../block.ts';
import { formatBlockPreview } from './ambiguous.ts';

export function formatNoMatchMessage(
  bestSimilarity: number,
  threshold: number,
  bestBlock: BlockExcerpt | null,
  hintMin: number,
): string {
  const head =
    `No sufficiently similar block found.\n` +
    `Best match: similarity ${bestSimilarity.toFixed(2)} at line ${
      bestBlock?.startLine ?? '?'
    } (below threshold ${threshold.toFixed(2)}).`;

  if (bestBlock && bestSimilarity >= hintMin) {
    return `${head}\n\nClosest block:\n${formatBlockPreview(bestBlock)}\n\nRe-read the file to see its current contents before retrying.`;
  }

  return head + `\n\nRe-read the file to see its current contents before retrying.`;
}
