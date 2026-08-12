import { stripLeadingWhitespace, normalizeText } from '../src/whitespace.ts';
import { assertEq, section } from './_framework.ts';

export function run(): void {
  section('whitespace: stripLeadingWhitespace');
  assertEq(stripLeadingWhitespace('    foo'), 'foo', 'strips 4 spaces');
  assertEq(stripLeadingWhitespace('  foo'), 'foo', 'strips 2 spaces');
  assertEq(stripLeadingWhitespace('foo'), 'foo', 'no-op when no leading whitespace');
  assertEq(stripLeadingWhitespace(''), '', 'empty string → empty');
  assertEq(stripLeadingWhitespace('   foo bar'), 'foo bar', 'strips only leading, not internal');

  section('whitespace: normalizeText');
  assertEq(normalizeText('    foo\n    bar'), 'foo\nbar', 'strips per line');
  assertEq(normalizeText('foo\nbar'), 'foo\nbar', 'no-op when already normalized');
  assertEq(
    normalizeText('    foo\n    bar'),
    'foo\nbar',
    'treats multiple lines correctly',
  );
}
