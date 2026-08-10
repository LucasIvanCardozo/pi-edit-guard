import { findFuzzyMatches } from '../../src/matchers/fuzzy.ts';
import { assert, assertEq, section } from '../_framework.ts';

export function run(): void {
  section('matchers/fuzzy: exact match');
  {
    const matches = findFuzzyMatches('foo bar\nbaz qux\n', 'foo bar', 0.9);
    assertEq(matches.length, 1, '1 match');
    assertEq(matches[0].startLine, 1, 'line 1');
    assert(matches[0].similarity > 0.99, 'perfect similarity');
  }

  section('matchers/fuzzy: small typo');
  {
    // 1-char diff on 13-char line: 1 - 1/13 = 0.923 → above 0.9
    const file = 'function foo() {\n  return 12345;\n}\n';
    const matches = findFuzzyMatches(file, '  return 12346;', 0.9);
    assertEq(matches.length, 1, '1 fuzzy match');
    assert(matches[0].similarity >= 0.9, `similarity ${matches[0].similarity} >= 0.9`);
  }

  section('matchers/fuzzy: below threshold');
  {
    // 6-char diff on ~30-char line: similarity ~0.8 → below 0.9
    const file = '      await triggerOrderStatusChanged("a", "b", "c");\n';
    const matches = findFuzzyMatches(file, '      await triggerOrderPrntJobd("a", "b", "c");', 0.9);
    assertEq(matches.length, 0, '0 matches above threshold');
  }

  section('matchers/fuzzy: empty');
  assertEq(findFuzzyMatches('foo', '', 0.9).length, 0, 'empty needle → 0');
  assertEq(findFuzzyMatches('foo', 'foo\nbar', 0.9).length, 0, 'needle longer than file → 0');

  section('matchers/fuzzy: 1-char diff (Levenshtein = 1)');
  {
    // "foo" vs "fooo" → distance 1, maxLen 4, similarity 0.75
    const matches = findFuzzyMatches('fooo\nbar\n', 'foo', 0.5);
    assertEq(matches.length, 1, '1 match above 0.5');
    assert(matches[0].similarity < 0.8, 'similarity below 0.8');
  }
}
