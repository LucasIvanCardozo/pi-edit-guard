import {
  formatAmbiguousMessage,
  formatBlockPreview,
  formatCandidate,
  formatConsolidatedReport,
  formatEvaluationSection,
  formatExamples,
  formatNoMatchMessage,
} from '../src/format/index.ts';
import type { EditEvaluation } from '../src/types.ts';
import { assert, assertEq, assertMatch, section } from './_framework.ts';

const THRESHOLD = 0.9;
const HINT_MIN = 0.5;

export function run(): void {
  section('format: formatCandidate (indentation, unfixable case)');
  {
    // v0.7+ behavior: when autofix can't apply, the message is the file's
    // verbatim lines plus a line range. No per-line markers or legend.
    const msg = formatCandidate(5, ['    if (x) {', '      return y;', '    }'], 'indentation');
    assertMatch(msg, /Indentation in your oldText didn't match/, 'mentions indent mismatch');
    assertMatch(msg, /Lines 5-7/, 'shows line range');
    assertMatch(msg, /Use these lines verbatim/, 'gives actionable instruction');
    assertMatch(msg, /including leading whitespace/, 'reminds about leading whitespace');
    assertMatch(msg, /```\n {4}if \(x\) \{\n {6}return y;\n {4}\}\n```/, 'block shows file lines verbatim');
    assert(!msg.includes('[0sp]'), 'no per-line markers in v0.7+ output');
    assert(!msg.includes('sp = spaces, tb = tabs'), 'no indent legend in v0.7+ output');
  }

  section('format: formatCandidate (fuzzy)');
  {
    const msg = formatCandidate(10, ['  return 1;'], 'fuzzy');
    assertMatch(msg, /small difference/, 'mentions small difference');
    assertMatch(msg, /Use this block verbatim/, 'fuzzy message uses verbatim instruction');
    assertMatch(msg, /```\n {2}return 1;\n```/, 'block shows file lines verbatim');
    assert(!msg.includes('[0sp]'), 'fuzzy does not add indent markers');
    assert(!msg.includes('sp = spaces'), 'fuzzy does not show indent legend');
  }

  section('format: formatExamples');
  {
    const ex = formatExamples([
      { startLine: 5, lines: ['foo', 'bar'] },
      { startLine: 10, lines: ['baz'] },
    ]);
    assertMatch(ex, /Lines 5-6/, 'first example range');
    assertMatch(ex, /Lines 10-10/, 'second example range');
    assertMatch(ex, /```\n {2}foo\n {2}bar\n```/, 'first example content');
  }

  section('format: formatAmbiguousMessage (literal)');
  {
    const msg = formatAmbiguousMessage(
      13,
      [
        { startLine: 3, lines: ['  });'] },
        { startLine: 6, lines: ['  });'] },
        { startLine: 9, lines: ['  });'] },
      ],
      1.0,
    );
    assertMatch(msg, /Found 13 similar blocks/, 'shows count');
    assertMatch(msg, /First 3 examples/, 'shows example count');
    assertMatch(msg, /\(literal\)/, 'labels as literal');
    assertMatch(msg, /Lines 3-3/, 'example 1');
    assertMatch(msg, /Lines 6-6/, 'example 2');
    assertMatch(msg, /Lines 9-9/, 'example 3');
  }

  section('format: formatAmbiguousMessage (fuzzy)');
  {
    const msg = formatAmbiguousMessage(5, [{ startLine: 1, lines: ['foo'] }], 0.85);
    assertMatch(msg, /similarity ≥ 0\.85/, 'labels with threshold');
  }

  section('format: formatNoMatchMessage with hint');
  {
    const msg = formatNoMatchMessage(
      0.62,
      0.9,
      { startLine: 47, lines: ['      await triggerOrderStatusChanged(...)'] },
      0.5,
    );
    assertMatch(msg, /No sufficiently similar block found/, 'no-match header');
    assertMatch(msg, /Best match: similarity 0\.62/, 'shows best similarity');
    assertMatch(msg, /at line 47/, 'shows line number');
    assertMatch(msg, /below threshold 0\.90/, 'shows threshold');
    assertMatch(msg, /Closest block/, 'shows hint block');
  }

  section('format: formatNoMatchMessage without hint (below hint min)');
  {
    const msg = formatNoMatchMessage(0.3, 0.9, { startLine: 5, lines: ['x'] }, 0.5);
    assertMatch(msg, /No sufficiently similar block found/, 'no-match header');
    assert(!msg.includes('Closest block'), 'no hint block when below hint min');
  }

  section('format: formatNoMatchMessage with no best block');
  {
    const msg = formatNoMatchMessage(0, 0.9, null, 0.5);
    assertMatch(msg, /Best match: similarity 0\.00/, 'shows 0.00');
    assert(!msg.includes('Closest block'), 'no hint when no block');
  }

  section('format: formatEvaluationSection (each kind)');
  {
    const evals: EditEvaluation[] = [
      { kind: 'ok-literal' },
      { kind: 'unique-drift', block: { startLine: 2, lines: ['    return 1;'] } },
      { kind: 'fuzzy-match', block: { startLine: 3, lines: ['foo'] }, similarity: 0.95 },
      { kind: 'ambiguous-literal', count: 3, examples: [] },
      { kind: 'no-match', bestSimilarity: 0.4, bestBlock: null },
    ];
    assertEq(formatEvaluationSection(evals[0], 1, THRESHOLD, HINT_MIN), '', 'ok-literal is empty');
    assertMatch(
      formatEvaluationSection(evals[1], 2, THRESHOLD, HINT_MIN),
      /^Edit 2:/,
      'drift is numbered',
    );
    assertMatch(
      formatEvaluationSection(evals[2], 3, THRESHOLD, HINT_MIN),
      /similarity 0\.95/,
      'fuzzy shows similarity',
    );
    assertMatch(
      formatEvaluationSection(evals[3], 4, THRESHOLD, HINT_MIN),
      /Found 3 similar blocks/,
      'ambiguous shows count',
    );
    assertMatch(
      formatEvaluationSection(evals[4], 5, THRESHOLD, HINT_MIN),
      /No sufficiently similar/,
      'no-match shows header',
    );
  }

  section('format: formatConsolidatedReport (all-ok returns null)');
  {
    const evals: EditEvaluation[] = [{ kind: 'ok-literal' }, { kind: 'ok-literal' }];
    const report = formatConsolidatedReport(evals, 2, THRESHOLD, HINT_MIN);
    assertEq(report, null, 'no report when all pass');
  }

  section('format: formatConsolidatedReport (mixed batch)');
  {
    const evals: EditEvaluation[] = [
      { kind: 'unique-drift', block: { startLine: 2, lines: ['    return 1;'] } },
      { kind: 'ok-literal' },
      { kind: 'ambiguous-literal', count: 5, examples: [{ startLine: 3, lines: ['  });'] }] },
    ];
    const report = formatConsolidatedReport(evals, 3, THRESHOLD, HINT_MIN);
    assertMatch(report!, /Edit guard: 2 of 3 edits have issues/, 'header counts 2 of 3');
    assertMatch(report!, /Edit 1:/, 'edit 1 listed');
    assertMatch(report!, /Edit 3:/, 'edit 3 listed');
    assert(!report!.includes('Edit 2:'), 'edit 2 not listed (ok)');
    assertMatch(report!, /Fix the issues above/, 'closing instruction');
  }

  section('format: formatConsolidatedReport (single edit)');
  {
    const evals: EditEvaluation[] = [{ kind: 'no-match', bestSimilarity: 0.3, bestBlock: null }];
    const report = formatConsolidatedReport(evals, 1, THRESHOLD, HINT_MIN);
    assertMatch(report!, /Edit guard: 1 of 1 edit has issues/, 'singular grammar');
  }
}
