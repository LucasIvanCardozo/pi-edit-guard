/**
 * Whitespace helpers.
 *
 * Pure functions for normalizing and describing leading whitespace per line.
 * No I/O, no side effects.
 */

export function stripLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, '');
}

export function normalizeText(text: string): string {
  return text.split('\n').map(stripLeadingWhitespace).join('\n');
}

/**
 * Compact indent descriptor for minimal token usage in user-facing output.
 *
 *   "    code" → "4sp"
 *   "\t\tcode" → "2tb"
 *   "  \tcode" → "2sp+1tb"
 *   "code"     → "0sp"
 *
 * Note: an empty string and an empty-indent line both return `"0sp"`. We use
 * `"0sp"` rather than `"-"` so the model sees a consistent `[Xsp]` /
 * `[Xtb]` marker format and never needs to learn a special-case symbol.
 */
export function describeIndent(line: string): string {
  const match = line.match(/^([ \t]+)/);
  if (!match) return '0sp';
  const indent = match[1];
  const spaces = (indent.match(/ /g) || []).length;
  const tabs = (indent.match(/\t/g) || []).length;
  if (spaces > 0 && tabs > 0) return `${spaces}sp+${tabs}tb`;
  if (spaces > 0) return `${spaces}sp`;
  if (tabs > 0) return `${tabs}tb`;
  return '0sp';
}
