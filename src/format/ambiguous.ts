/**
 * Ambiguous-message formatters.
 *
 * `formatExamples` renders a list of `BlockExcerpt` as bulleted blocks with
 * line ranges and indented previews. `formatAmbiguousMessage` wraps that
 * with the "Found N similar blocks" header.
 *
 * `formatBlockPreview` is the shared primitive used here and by the
 * no-match message — DRY across the format layer.
 */

import type { BlockExcerpt } from '../block.ts';

export function formatBlockPreview(block: BlockExcerpt): string {
  const last = block.startLine + block.lines.length - 1;
  const preview = block.lines.map((l) => `  ${l}`).join('\n');
  return `- Lines ${block.startLine}-${last}:\n\`\`\`\n${preview}\n\`\`\``;
}

export function formatExamples(examples: BlockExcerpt[]): string {
  return examples.map(formatBlockPreview).join('\n');
}

export function formatAmbiguousMessage(
  count: number,
  examples: BlockExcerpt[],
  threshold: number,
): string {
  const kind = threshold === 1.0 ? 'literal' : `similarity ≥ ${threshold.toFixed(2)}`;
  return (
    `Found ${count} similar blocks (${kind}).\n` +
    `First ${examples.length} examples:\n` +
    formatExamples(examples) +
    `\n\nRe-read the file and provide a more specific oldText that uniquely identifies the target block.`
  );
}
