import { countLineAnchoredMatches, findLineAnchoredMatches } from '../../src/matchers/literal.ts';
import { assert, assertEq, section } from '../_framework.ts';

export function run(): void {
  section('matchers/literal: countLineAnchoredMatches');
  {
    const file = '  return 1;\n  return 2;\n  return 1;\n';
    assertEq(countLineAnchoredMatches(file, '  return 1;'), 2, '2 line-anchored matches');

    // The substring bug: "  return 1;" is a substring of "    return 1;" but
    // it's not line-anchored, so it must NOT be counted.
    const indented = '    return 1;\n  return 2;\n';
    assertEq(
      countLineAnchoredMatches(indented, '  return 1;'),
      0,
      'substring NOT counted (bug fix)',
    );

    // Empty needle
    assertEq(countLineAnchoredMatches('foo', ''), 0, 'empty needle → 0');
    // Empty haystack
    assertEq(countLineAnchoredMatches('', 'foo'), 0, 'empty haystack → 0');
    // Match at position 0
    assertEq(countLineAnchoredMatches('foo bar', 'foo bar'), 1, 'match at position 0');
  }

  section('matchers/literal: findLineAnchoredMatches');
  {
    const file = 'alpha\n  return 1;\nbeta\n  return 1;\n';
    const result = findLineAnchoredMatches(file, '  return 1;');
    assertEq(result.count, 2, 'count is 2');
    assertEq(result.matches.length, 2, '2 matches');
    assertEq(result.matches[0].startLine, 2, 'first match at line 2');
    assertEq(result.matches[0].matchedLines, ['  return 1;'], 'preserves content');
    assertEq(result.matches[1].startLine, 4, 'second match at line 4');
  }
  {
    const file = '    return 1;\n  return 2;\n';
    const result = findLineAnchoredMatches(file, '  return 1;');
    assertEq(result.count, 0, 'no substring match');
    assertEq(result.matches.length, 0, 'matches is empty');
  }
  {
    const result = findLineAnchoredMatches('foo', '');
    assertEq(result.count, 0, 'empty needle returns 0 count');
    assertEq(result.matches.length, 0, 'empty needle returns []');
  }
}
