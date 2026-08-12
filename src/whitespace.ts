/**
 * Whitespace helpers.
 *
 * Pure functions for normalizing leading whitespace per line. No I/O, no side
 * effects.
 *
 * The project assumes files use leading SPACES only (no tabs). Tabs are
 * treated as content, not indent.
 */

export function stripLeadingWhitespace(line: string): string {
  return line.replace(/^[ ]+/, '');
}

export function normalizeText(text: string): string {
  return text.split('\n').map(stripLeadingWhitespace).join('\n');
}
