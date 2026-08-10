import { describeIndent, normalizeText, stripLeadingWhitespace } from '../src/whitespace.ts';
import { assert, assertEq, section } from './_framework.ts';

export function run(): void {
  section('whitespace: stripLeadingWhitespace');
  assertEq(stripLeadingWhitespace('    foo'), 'foo', 'strips 4 spaces');
  assertEq(stripLeadingWhitespace('\tfoo'), 'foo', 'strips 1 tab');
  assertEq(stripLeadingWhitespace('  \tfoo'), 'foo', 'strips mixed spaces+tabs');
  assertEq(stripLeadingWhitespace('foo'), 'foo', 'no-op when no leading whitespace');
  assertEq(stripLeadingWhitespace(''), '', 'empty string → empty');
  assertEq(stripLeadingWhitespace('   foo bar'), 'foo bar', 'strips only leading, not internal');

  section('whitespace: normalizeText');
  assertEq(normalizeText('    foo\n    bar'), 'foo\nbar', 'strips per line');
  assertEq(normalizeText('foo\nbar'), 'foo\nbar', 'no-op when already normalized');
  assertEq(normalizeText('\tfoo\n\tbar'), 'foo\nbar', 'strips tabs per line');

  section('whitespace: describeIndent');
  assertEq(describeIndent('    code'), '4sp', '4 spaces');
  assertEq(describeIndent('\t\tcode'), '2tb', '2 tabs');
  assertEq(describeIndent('  \tcode'), '2sp+1tb', 'mixed');
  assertEq(describeIndent('code'), '-', 'no indent');
  assertEq(describeIndent(''), '-', 'empty line');
  assertEq(describeIndent('  '), '2sp', 'only whitespace');
}
