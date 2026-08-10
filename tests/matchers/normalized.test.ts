import { findNormalizedMatches } from '../../src/matchers/normalized.ts';
import { assert, assertEq, section } from '../_framework.ts';

export function run(): void {
  section('matchers/normalized: basic match');
  {
    const file = '    foo\n    bar\n    baz\n';
    const matches = findNormalizedMatches(file, 'foo\nbar');
    assertEq(matches.length, 1, '1 match');
    assertEq(matches[0].startLine, 1, 'line 1');
    assertEq(matches[0].matchedLines, ['    foo', '    bar'], 'preserves original indent');
  }

  section('matchers/normalized: drift detection');
  {
    // The model wrote "  return 1;" (2sp) but file has "    return 1;" (4sp)
    const file = 'function foo() {\n    return 1;\n}\n';
    const matches = findNormalizedMatches(file, 'return 1;');
    assertEq(matches.length, 1, '1 normalized match despite indent diff');
    assertEq(matches[0].matchedLines, ['    return 1;'], "preserves file's actual indent");
  }

  section('matchers/normalized: ambiguous');
  {
    const file = '    foo\n    bar\n    foo\n    bar\n';
    const matches = findNormalizedMatches(file, 'foo\nbar');
    assertEq(matches.length, 2, '2 matches');
  }

  section('matchers/normalized: defensive guards');
  {
    const matches = findNormalizedMatches('foo bar', '');
    assertEq(matches.length, 0, 'empty needle returns []');
    const matches2 = findNormalizedMatches('foo bar', '   \n   ');
    assertEq(matches2.length, 0, 'whitespace-only needle returns []');
  }
}
