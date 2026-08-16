/**
 * Unit tests for `tryAutofix`.
 *
 * Pure-function tests: no I/O, no mocks. Each test constructs a minimal
 * BlockExcerpt and a `{oldText, newText}` pair, then asserts on the result.
 *
 * As of v0.8.0 `tryAutofix` returns a discriminated union
 * `{ ok: true; result } | { ok: false; decline }` instead of `result | null`.
 * The helper `unwrap` below collapses that into `result | null` so the
 * majority of tests can keep their shape, while dedicated sections verify
 * the specific decline reasons.
 */

import type { AutofixResult } from '../src/autofix.ts';
import {
  countLeadingSpaces,
  hasLeadingTab,
  shiftLeadingSpaces,
  tryAutofix,
} from '../src/autofix.ts';
import { assert, assertEq, section } from './_framework.ts';

/** Test helper: returns the successful AutofixResult or null. */
function unwrap(fix: ReturnType<typeof tryAutofix>): AutofixResult | null {
  return fix.ok ? fix.result : null;
}

/** Test helper: returns the decline reason or null. */
function declineReason(fix: ReturnType<typeof tryAutofix>): string | null {
  return fix.ok ? null : fix.decline.reason;
}

export function run(): void {
  section('autofix: shiftLeadingSpaces (primitive)');
  assertEq(shiftLeadingSpaces('  return;', 2), '    return;', '+2 spaces');
  assertEq(shiftLeadingSpaces('    return;', -2), '  return;', '-2 spaces');
  assertEq(shiftLeadingSpaces('  return;', 0), '  return;', '0 shift is identity');
  assertEq(shiftLeadingSpaces('return;', 4), '    return;', '0 leading +4 becomes 4');
  assertEq(
    shiftLeadingSpaces('  ', 5),
    '  ',
    'whitespace-only line treated as blank, stays unchanged',
  );
  assertEq(shiftLeadingSpaces('', 5), '', 'empty line stays empty');
  assertEq(shiftLeadingSpaces('    return;', -10), 'return;', 'negative clamps to 0');

  section('autofix: countLeadingSpaces');
  assertEq(countLeadingSpaces('    code'), 4, '4 leading spaces');
  assertEq(countLeadingSpaces('  code'), 2, '2 leading spaces');
  assertEq(countLeadingSpaces('code'), 0, 'no leading spaces');
  assertEq(countLeadingSpaces(''), 0, 'empty string');

  section('autofix: hasLeadingTab');
  assert(hasLeadingTab('\tcode'), 'pure tab');
  assert(hasLeadingTab('\t\tcode'), 'two tabs');
  assert(!hasLeadingTab('    code'), 'pure spaces is not tab');
  assert(!hasLeadingTab('code'), 'no leading whitespace is not tab');
  assert(!hasLeadingTab(''), 'empty string');

  section('autofix: tryAutofix uniform +2 spaces shift (single-line)');
  {
    const fix = tryAutofix(
      { oldText: '  return 1;', newText: '  return 2;' },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assert(fix.ok, 'returns ok for uniform +2 shift');
    if (fix.ok) {
      assertEq(fix.result.delta, 2, 'delta is +2');
      assertEq(fix.result.correctedOldText, '    return 1;', 'correctedOldText is the file block');
      assertEq(
        fix.result.correctedNewText,
        '    return 2;',
        'correctedNewText has shifted leading spaces',
      );
      assertEq(fix.result.startLine, 2, 'startLine preserved');
      assertEq(fix.result.endLine, 2, 'endLine preserved');
    }
  }

  section('autofix: tryAutofix uniform -2 spaces shift (multi-line)');
  {
    // Model over-indented (4sp), file has 2sp → delta -2
    const modelText = '    return 1;\n  }';
    const fileText = '  return 1;\n}';
    const fix = tryAutofix(
      { oldText: modelText, newText: '    return 2;\n  }' },
      { startLine: 1, lines: ['  return 1;', '}'] },
    );
    assert(fix.ok, 'returns ok for uniform -2 shift');
    if (fix.ok) {
      assertEq(fix.result.delta, -2, 'delta is -2');
      assertEq(fix.result.correctedOldText, fileText, 'correctedOldText matches file verbatim');
      assertEq(
        fix.result.correctedNewText,
        '  return 2;\n}',
        'newText leading spaces shifted by -2 uniformly',
      );
      assertEq(fix.result.startLine, 1, 'startLine preserved');
      assertEq(fix.result.endLine, 2, 'endLine preserved');
    }
  }

  section('autofix: tryAutofix non-uniform delta declines with specific reason');
  {
    // First non-blank line: model 0sp, file 2sp → delta +2
    // Second non-blank line: model 2sp, file 2sp → delta 0
    // → inconsistent → decline with reason 'non-uniform-delta'
    const fix = tryAutofix(
      {
        oldText: 'if (x) {\n    return 1;\n  }',
        newText: 'if (x) {\n    return 2;\n  }',
      },
      { startLine: 1, lines: ['  if (x) {', '    return 1;', '  }'] },
    );
    assert(!fix.ok, 'declines when delta is non-uniform');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'non-uniform-delta', 'specific reason reported');
      assertEq(fix.decline.deltaLine, 1, 'reports 0-indexed line where delta differs');
    }
  }

  section('autofix: tryAutofix zero delta declines with reason "zero-delta"');
  {
    const fix = tryAutofix(
      { oldText: '    return 1;', newText: '    return 2;' },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'declines for 0 delta (cascade would say ok-literal)');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'zero-delta', 'specific reason reported');
    }
  }

  section('autofix: tryAutofix blank-line-only block declines with reason "zero-delta"');
  {
    // Both sides have only blank lines. We can't compute a delta.
    const fix = tryAutofix({ oldText: '\n', newText: '\n' }, { startLine: 1, lines: ['', ''] });
    assert(!fix.ok, 'declines when no non-blank lines exist');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'zero-delta', 'specific reason reported');
    }
  }

  section('autofix: tryAutofix ignores blank-line mismatch');
  {
    // Model has blank line where file has 2sp. We skip that pair (both can't be blank
    // AND one of them is blank — we skip). First real pair gives delta.
    const fix = tryAutofix(
      {
        oldText: '    foo();\n\n    bar();',
        newText: '    baz();\n\n    qux();',
      },
      { startLine: 1, lines: ['  foo();', '', '  bar();'] },
    );
    assert(fix.ok, 'returns ok when only non-blank pairs drive the delta');
    if (fix.ok) {
      assertEq(fix.result.delta, -2, 'delta derived from non-blank pairs only');
      assertEq(
        fix.result.correctedNewText,
        '  baz();\n\n  qux();',
        'newText shifted where lines are non-blank; blank line stays untouched',
      );
    }
  }

  section('autofix: tryAutofix declines for tab in oldText with specific reason');
  {
    const fix = tryAutofix(
      { oldText: '\treturn 1;', newText: '\treturn 2;' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'declines when oldText uses tabs');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-oldtext', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports 0-indexed line of tab');
    }
  }

  section('autofix: tryAutofix declines for tab in file block with specific reason');
  {
    const fix = tryAutofix(
      { oldText: '    return 1;', newText: '    return 2;' },
      { startLine: 1, lines: ['\treturn 1;'] },
    );
    assert(!fix.ok, 'declines when file uses tabs');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-file-block', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports 0-indexed line of tab');
    }
  }

  section('autofix: tryAutofix declines for empty newText (delete case)');
  {
    const fix = tryAutofix(
      { oldText: '    return 1;', newText: '' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'declines when newText is empty (delta would be 0)');
    if (!fix.ok) {
      assertEq(
        fix.decline.reason,
        'zero-delta',
        'specific reason reported (treated as zero-delta)',
      );
    }
  }

  section('autofix: tryAutofix normalizes CRLF before processing');
  {
    const fix = tryAutofix(
      {
        oldText: '  return 1;\r\n    return 2;',
        newText: '  return 9;\r\n    return 8;',
      },
      { startLine: 1, lines: ['    return 1;', '      return 2;'] },
    );
    assert(fix.ok, 'returns ok despite CRLF line endings in input');
    if (fix.ok) {
      assertEq(fix.result.delta, 2, 'delta correctly computed after CRLF→LF normalization');
      assertEq(
        fix.result.correctedNewText,
        '    return 9;\n      return 8;',
        'CRLF line endings stripped from correctedNewText',
      );
    }
  }

  section('autofix: tryAutofix declines for line-count mismatch with specific reason');
  {
    const fix = tryAutofix(
      { oldText: '  return 1;\n  }', newText: '  return 2;\n  }' },
      { startLine: 1, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'declines when oldText and block have different line counts');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'line-count-mismatch', 'specific reason reported');
      assertEq(fix.decline.mismatch?.model, 2, 'reports model line count');
      assertEq(fix.decline.mismatch?.file, 1, 'reports file line count');
    }
  }

  section('autofix: tryAutofix declines when MAX_SANE_DELTA exceeded with specific reason');
  {
    // 100-space file block, 0-space model oldText. Delta is 100, well above MAX_SANE_DELTA (50).
    const fileLines = [`${' '.repeat(100)}return 1;`];
    const fix = tryAutofix(
      { oldText: 'return 1;', newText: 'return 2;' },
      { startLine: 1, lines: fileLines },
    );
    assert(!fix.ok, 'declines when |delta| exceeds MAX_SANE_DELTA');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'delta-too-large', 'specific reason reported');
      assertEq(fix.decline.absDelta, 100, 'reports the absolute delta observed');
    }
  }

  section('autofix: tryAutofix declines for missing fields with specific reason');
  {
    const fix1 = tryAutofix({}, { startLine: 1, lines: [] });
    assert(!fix1.ok, 'declines when oldText/newText missing');
    if (!fix1.ok) {
      assertEq(fix1.decline.reason, 'missing-text', 'specific reason reported');
    }

    const fix2 = tryAutofix({ newText: 'x' }, { startLine: 1, lines: [''] });
    assert(!fix2.ok, 'declines when oldText alone missing');
    if (!fix2.ok) {
      assertEq(fix2.decline.reason, 'missing-text', 'specific reason reported');
    }

    const fix3 = tryAutofix({ oldText: '' }, { startLine: 1, lines: [''] });
    assert(!fix3.ok, 'declines when oldText is empty');
    if (!fix3.ok) {
      assertEq(fix3.decline.reason, 'missing-text', 'specific reason reported');
    }
  }

  section('autofix: tryAutofix produces valid newText when newText had different leading');
  {
    // Model oldText starts at 0sp, file has 4sp, delta = +4
    // newText starts at 0sp too — would normally not match the file's 4sp style,
    // but after shift it correctly has 4sp
    const fix = tryAutofix(
      {
        oldText: 'if (x) {\n  foo();\n}',
        newText: 'if (y) {\n  bar();\n}',
      },
      { startLine: 1, lines: ['    if (x) {', '      foo();', '    }'] },
    );
    assert(fix.ok, 'returns ok for this delta');
    if (fix.ok) {
      assertEq(fix.result.delta, 4, 'delta is +4');
      assertEq(
        fix.result.correctedNewText,
        '    if (y) {\n      bar();\n    }',
        'newText shifted uniformly by +4',
      );
    }
  }

  section('autofix: tryAutofix declines when newText has leading tab (file pollution guard)');
  {
    // Regression: shifting newText with leading tab would write mixed-indent
    // (spaces + tab) back to a spaces-only file. The guard declines and
    // falls through to the existing block+report path.
    const fix = tryAutofix(
      {
        oldText: '  return 1;',
        newText: '\t  return 99;',
      },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'declines when newText has leading tab');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-newtext', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports 0-indexed line of tab');
    }
  }

  section('autofix: tryAutofix declines when newText mixes tab and spaces in leading');
  {
    // Even when some lines have correct spaces-only indent, the presence
    // of any tab in any line's leading whitespace forces decline to
    // prevent the file from being polluted.
    const fix = tryAutofix(
      {
        oldText: '  const a = 1;\n  const b = 2;',
        newText: '\t  const a = 99;\n    const b = 88;',
      },
      { startLine: 1, lines: ['    const a = 1;', '    const b = 2;'] },
    );
    assert(!fix.ok, 'declines when any newText line has mixed tab+spaces');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-newtext', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports the first line with tab');
    }
  }

  section('autofix: tryAutofix declines when CRLF + leading tab in newText');
  {
    const fix = tryAutofix(
      {
        oldText: '  return 1;\r\n  return 2;',
        newText: '\t  return 99;\r\n    return 88;',
      },
      { startLine: 1, lines: ['    return 1;', '    return 2;'] },
    );
    assert(!fix.ok, 'declined after CRLF normalization detects tab');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-newtext', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports 0-indexed line');
    }
  }

  section('autofix: tryAutofix declines when newText has tab mid-leading (after spaces)');
  {
    // hasLeadingTab must catch a tab that appears after leading spaces,
    // not only at column 0. e.g., `  \treturn` should be detected.
    const fix = tryAutofix(
      {
        oldText: '  return 1;',
        newText: '  \t  return 99;',
      },
      { startLine: 2, lines: ['    return 1;'] },
    );
    assert(!fix.ok, 'detects tab mid-leading whitespace');
    if (!fix.ok) {
      assertEq(fix.decline.reason, 'tab-in-newtext', 'specific reason reported');
      assertEq(fix.decline.tabLine, 0, 'reports 0-indexed line');
    }
  }

  section('autofix: tryAutofix accepts newText with tabs mid-line (non-leading)');
  {
    // Tabs in the content (after leading whitespace) are not indent and
    // must not trigger decline. e.g., `const s = 'a\tb'`.
    const fix = tryAutofix(
      {
        oldText: "  const s = 'a\\tb';",
        newText: "  const s = 'x\\ty';",
      },
      { startLine: 2, lines: ["    const s = 'a\\tb';"] },
    );
    assert(fix.ok, 'does not decline on mid-line tab in newText');
    if (fix.ok) {
      assertEq(fix.result.delta, 2, 'uniform shift delta');
      assertEq(
        fix.result.correctedNewText,
        "    const s = 'x\\ty';",
        'newText shifted uniformly; mid-line tab preserved as content',
      );
    }
  }
}
