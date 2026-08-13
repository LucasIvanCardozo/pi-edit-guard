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

      section('matchers/normalized: REGRESSION — no substring false positives');
      {
        // v0.5.0-v0.7.2 used String.indexOf on joined normalized lines. That
        // matched 'const head' inside BOTH 'const head = ...' AND 'const
        // header = ...' (substring). Matcher returned ambiguous-normalized
        // with one real match and one bogus match — the model couldn't tell
        // which was the target and entered a surrender loop.
        const file = [
          'function formatEvaluationSection(',
          '  editIndex: number,',
          '  theme: ThemeLike,',
          '  hintMin: number,',
          '): string {',
          '  const header = "Edit X:";',
          '  switch (evaluation.kind) {',
          '    case "ok-literal":',
          '      return "";',
          '  }',
          '}',
          '',
          'export function formatConsolidatedReport(',
          '  evaluations: EditEvaluation[],',
          '  total: number,',
          '): string | null {',
          '  const head = "Edit guard: N of M";',
          '  return head;',
          '}',
          '',
        ].join('\n');
        const matches = findNormalizedMatches(file, 'const head');
        assertEq(matches.length, 0, 'sub-needle "const head" no longer false-matches "const header"');
      }

      section('matchers/normalized: REGRESSION — no cross-line false positives');
      {
        // Old behavior: indexOf('foo\nbar') matched across line boundaries
        // (semantically unrelated lines). New behavior: exact line equality.
        const file = [
          'line one has trailing something foo',
          'bar line two starts here',
          '  foo',
          '  bar',
        ].join('\n');
        const matches = findNormalizedMatches(file, 'foo\nbar');
        assertEq(matches.length, 1, 'no cross-line false match');
        assertEq(matches[0].startLine, 3, 'real match is on lines 3-4');
      }

}
