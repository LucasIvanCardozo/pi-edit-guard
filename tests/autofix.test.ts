/**
 * Unit tests for `tryAutofix`.
 *
 * Pure-function tests: no I/O, no mocks. Each test constructs a minimal
 * BlockExcerpt and a `{oldText, newText}` pair, then asserts on the result.
 */

import {
  countLeadingSpaces,
  hasLeadingTab,
  shiftLeadingSpaces,
  tryAutofix,
} from '../src/autofix.ts';
import { assert, assertEq, section } from './_framework.ts';

export function run(): void {
  section('autofix: shiftLeadingSpaces (primitive)');
  {
    assertEq(shiftLeadingSpaces('  return;', 2), '    return;', '+2 spaces');
    assertEq(shiftLeadingSpaces('    return;', -2), '  return;', '-2 spaces');
    assertEq(shiftLeadingSpaces('  return;', 0), '  return;', '0 shift is identity');
    assertEq(shiftLeadingSpaces('return;', 4), '    return;', '0 leading +4 becomes 4');
    assertEq(shiftLeadingSpaces('  ', 5), '  ', 'whitespace-only line treated as blank, stays unchanged');
    assertEq(shiftLeadingSpaces('', 5), '', 'empty line stays empty');
    assertEq(shiftLeadingSpaces('    return;', -10), 'return;', 'negative clamps to 0');
  }

  section('autofix: countLeadingSpaces');
  {
    assertEq(countLeadingSpaces('    code'), 4, '4 leading spaces');
    assertEq(countLeadingSpaces('  code'), 2, '2 leading spaces');
    assertEq(countLeadingSpaces('code'), 0, 'no leading spaces');
    assertEq(countLeadingSpaces(''), 0, 'empty string');
  }

  section('autofix: hasLeadingTab');
  {
    assert(hasLeadingTab('\tcode'), 'pure tab');
    assert(hasLeadingTab('\t\tcode'), 'two tabs');
    assert(!hasLeadingTab('    code'), 'pure spaces is not tab');
    assert(!hasLeadingTab('code'), 'no leading whitespace is not tab');
    assert(!hasLeadingTab(''), 'empty string');
  }

  section('autofix: tryAutofix uniform +2 spaces shift (single-line)');
  {
    const result = tryAutofix(
      { oldText: '  return 1;', newText: '  return 2;' },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assert(result !== null, 'returns a result for uniform +2 shift');
    if (result) {
      assertEq(result.delta, 2, 'delta is +2');
      assertEq(result.correctedOldText, '    return 1;', 'correctedOldText is the file block');
      assertEq(result.correctedNewText, '    return 2;', 'correctedNewText has shifted leading spaces');
      assertEq(result.startLine, 2, 'startLine preserved');
      assertEq(result.endLine, 2, 'endLine preserved');
    }
  }

  section('autofix: tryAutofix uniform -2 spaces shift (multi-line)');
  {
    // Model over-indented (4sp), file has 2sp → delta -2
    const modelText = '    return 1;\n  }';
    const fileText = '  return 1;\n}';
    const result = tryAutofix(
      { oldText: modelText, newText: '    return 2;\n  }' },
      { startLine: 1, lines: ['  return 1;', '}'] },
    );
    assert(result !== null, 'returns a result for uniform -2 shift');
    if (result) {
      assertEq(result.delta, -2, 'delta is -2');
      assertEq(result.correctedOldText, fileText, 'correctedOldText matches file verbatim');
      assertEq(result.correctedNewText, '  return 2;\n}', 'newText leading spaces shifted by -2 uniformly');
      assertEq(result.startLine, 1, 'startLine preserved');
      assertEq(result.endLine, 2, 'endLine preserved');
    }
  }

  section('autofix: tryAutofix non-uniform delta returns null');
  {
    // First non-blank line: model 0sp, file 2sp → delta +2
    // Second non-blank line: model 2sp, file 2sp → delta 0
    // → inconsistent → null
    const result = tryAutofix(
      {
        oldText: '  if (x) {\n    return 1;\n  }',
        newText: '  if (x) {\n    return 2;\n  }',
      },
      { startLine: 1, lines: ['  if (x) {', '    return 1;', '  }'] },
    );
    assertEq(result, null, 'returns null when delta is non-uniform');
  }

  section('autofix: tryAutofix returns null when delta is 0 (would be ok-literal anyway)');
  {
    const result = tryAutofix(
      { oldText: '    return 1;', newText: '    return 2;' },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'returns null for 0 delta (cascade would say ok-literal)');
  }

  section('autofix: tryAutofix returns null for blank-line-only block');
  {
    // Both sides have only blank lines. We can't compute a delta.
    const result = tryAutofix(
      { oldText: '\n\n', newText: '\n' },
      { startLine: 1, lines: ['', ''] },
    );
    assertEq(result, null, 'returns null when no non-blank lines exist');
  }

  section('autofix: tryAutofix ignores blank-line mismatch');
  {
    // Model has blank line where file has 2sp. We skip that pair (both can't be blank
    // AND one of them is blank — we skip). First real pair gives delta.
    const result = tryAutofix(
      {
        oldText: '    foo();\n\n    bar();',
        newText: '    baz();\n\n    qux();',
      },
      { startLine: 1, lines: ['  foo();', '', '  bar();'] },
    );
    assert(result !== null, 'returns a result when only non-blank pairs drive the delta');
    if (result) {
      assertEq(result.delta, -2, 'delta derived from non-blank pairs only');
      assertEq(
        result.correctedNewText,
        '  baz();\n\n  qux();',
        'newText shifted where lines are non-blank; blank line stays untouched',
      );
    }
  }

  section('autofix: tryAutofix returns null for tab in oldText');
  {
    const result = tryAutofix(
      { oldText: '\treturn 1;', newText: '\treturn 2;' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'returns null when oldText uses tabs');
  }

  section('autofix: tryAutofix returns null for tab in file block');
  {
    const result = tryAutofix(
      { oldText: '    return 1;', newText: '    return 2;' },
      { startLine: 1, lines: ['\treturn 1;'] },
    );
    assertEq(result, null, 'returns null when file uses tabs');
  }

  section('autofix: tryAutofix returns null for empty newText delta = delete');
  {
    const result = tryAutofix(
      { oldText: '    return 1;', newText: '' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'returns null when newText is empty (delta would be 0)');
  }

  section('autofix: tryAutofix normalizes CRLF before processing');
  {
    const result = tryAutofix(
      {
        oldText: '  return 1;\r\n    return 2;',
        newText: '  return 9;\r\n    return 8;',
      },
      { startLine: 1, lines: ['    return 1;', '      return 2;'] },
    );
    assert(result !== null, 'returns a result despite CRLF line endings in input');
    if (result) {
      assertEq(result.delta, 2, 'delta correctly computed after CRLF→LF normalization');
      assertEq(
        result.correctedNewText,
        '    return 9;\n      return 8;',
        'CRLF line endings stripped from correctedNewText',
      );
    }
  }

  section('autofix: tryAutofix returns null for line-count mismatch');
  {
    const result = tryAutofix(
      { oldText: '  return 1;\n  }', newText: '  return 2;\n  }' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'returns null when oldText and block have different line counts');
  }

  section('autofix: tryAutofix returns null when MAX_SANE_DELTA exceeded (defense against bugs)');
  {
    // 100-space file block, 0-space model oldText. Delta is 100, well above MAX_SANE_DELTA (50).
    // The cascade WOULD have returned unique-drift here, but our defensive cap refuses.
    const fileLines = [' '.repeat(100) + 'return 1;'];
    const result = tryAutofix(
      { oldText: 'return 1;', newText: 'return 2;' },
      { startLine: 1, lines: fileLines },
    );
    assertEq(result, null, 'returns null when |delta| exceeds MAX_SANE_DELTA');
  }

  section('autofix: tryAutofix returns null for missing fields');
  {
    assertEq(tryAutofix({}, { startLine: 1, lines: [] }), null, 'missing oldText/newText → null');
    assertEq(
      tryAutofix({ newText: 'x' }, { startLine: 1, lines: [''] }),
      null,
      'missing oldText alone → null',
    );
    assertEq(
      tryAutofix({ oldText: '' }, { startLine: 1, lines: [''] }),
      null,
      'empty oldText → null',
    );
  }

  section('autofix: tryAutofix produces valid newText when newText had different leading');
  {
    // Model oldText starts at 0sp, file has 4sp, delta = +4
    // newText starts at 0sp too — would normally not match the file's 4sp style,
    // but after shift it correctly has 4sp
    const result = tryAutofix(
      {
        oldText: 'if (x) {\n  foo();\n}',
        newText: 'if (y) {\n  bar();\n}',
      },
      { startLine: 1, lines: ['    if (x) {', '      foo();', '    }'] },
    );
    assert(result !== null, 'returns a result for this delta');
    if (result) {
      assertEq(result.delta, 4, 'delta is +4');
      assertEq(
        result.correctedNewText,
        '    if (y) {\n      bar();\n    }',
        'newText shifted uniformly by +4',
      );
    }
  }

  section('autofix: tryAutofix declines when newText has leading tab (file pollution guard)');
  {
    // Regression for the bug caught by /tmp/peg-test-1: shifting newText
    // with leading tab would write mixed-indent (spaces + tab) back to a
    // spaces-only file. The guard now declines and falls through to the
    // existing block+report path.
    const result = tryAutofix(
      {
        oldText: '  return 1;',
        newText: '\t  return 99;',
      },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'returns null when newText has leading tab');
  }

  section('autofix: tryAutofix declines when newText mixes tab and spaces in leading');
  {
    // Even when some lines have correct spaces-only indent, the presence
    // of any tab in any line's leading whitespace forces decline to
    // prevent the file from being polluted.
    const result = tryAutofix(
      {
        oldText: '  const a = 1;\n  const b = 2;',
        newText: '\t  const a = 99;\n    const b = 88;',
      },
      { startLine: 1, lines: ['    const a = 1;', '    const b = 2;'] },
    );
    assertEq(result, null, 'returns null when any newText line has mixed tab+spaces');
  }

  section('autofix: tryAutofix declines when CRLF + leading tab in newText');
  {
    const result = tryAutofix(
      {
        oldText: '  return 1;\r\n  return 2;',
        newText: '\t  return 99;\r\n    return 88;',
      },
      { startLine: 1, lines: ['    return 1;', '    return 2;'] },
    );
    assertEq(result, null, 'declined after CRLF normalization detects tab');
  }

  section('autofix: tryAutofix declines when newText has tab mid-leading (after spaces)');
  {
    // hasLeadingTab must catch a tab that appears after leading spaces,
    // not only at column 0. e.g., `  \treturn` should be detected.
    const result = tryAutofix(
      {
        oldText: '  return 1;',
        newText: '  \t  return 99;',
      },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assertEq(result, null, 'detects tab mid-leading whitespace');
  }

  section('autofix: tryAutofix accepts newText with tabs mid-line (non-leading)');
  {
    // Tabs in the content (after leading whitespace) are not indent and
    // must not trigger decline. e.g., `const s = 'a\tb'`.
    const result = tryAutofix(
      {
        oldText: "  const s = 'a\\tb';",
        newText: "  const s = 'x\\ty';",
      },
      { startLine: 2, lines: ['    const s = \'a\\tb\';'] },
    );
    assert(result !== null, 'does not decline on mid-line tab in newText');
    if (result) {
      assertEq(result.delta, 2, 'uniform shift delta');
      assertEq(
        result.correctedNewText,
        "    const s = 'x\\ty';",
        'newText shifted uniformly; mid-line tab preserved as content',
      );
    }
  }
}
