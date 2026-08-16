import { evaluateBatch, evaluateEdit } from '../src/evaluate.ts';
import { assert, assertEq, section } from './_framework.ts';

const THRESHOLD = 0.9;
const MAX_EXAMPLES = 3;

export function run(): void {
  section('evaluate: ok-literal');
  {
    const evals = evaluateBatch('foo bar\n', [{ oldText: 'foo bar' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals.length, 1, 'returns 1 evaluation');
    assertEq(evals[0].kind, 'ok-literal', 'single literal match passes');
  }

  section('evaluate: unique-drift (the most common case)');
  {
    // oldText has wrong indent (2sp) but content matches after normalization
    const file = 'function foo() {\n    return 1;\n}\n';
    const evals = evaluateBatch(file, [{ oldText: '  return 1;' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'unique-drift', 'detects drift');
    if (evals[0].kind === 'unique-drift') {
      assertEq(evals[0].block.startLine, 2, 'finds correct line');
      assertEq(evals[0].block.lines, ['    return 1;'], 'returns correctly-indented block');
    }
  }

  section('evaluate: fuzzy-match');
  {
    const file = 'function foo() {\n  return 12345;\n}\n';
    const evals = evaluateBatch(file, [{ oldText: '  return 12346;' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'fuzzy-match', '1-char diff on long line');
    if (evals[0].kind === 'fuzzy-match') {
      assert(evals[0].similarity >= THRESHOLD, `similarity ${evals[0].similarity} >= ${THRESHOLD}`);
    }
  }

  section('evaluate: ambiguous-literal');
  {
    const file = '  return 1;\n  return 1;\n  return 2;\n';
    const evals = evaluateBatch(file, [{ oldText: '  return 1;' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'ambiguous-literal', '2 literal matches');
    if (evals[0].kind === 'ambiguous-literal') {
      assertEq(evals[0].count, 2, 'count is 2');
      assertEq(evals[0].examples.length, 2, 'provides 2 examples');
    }
  }

  section('evaluate: ambiguous-normalized');
  {
    // oldText matches 2 places after stripping indent
    const file = '    foo\n    bar\n        foo\n        bar\n';
    const evals = evaluateBatch(file, [{ oldText: 'foo\nbar' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'ambiguous-normalized', '2 normalized matches');
    if (evals[0].kind === 'ambiguous-normalized') {
      assertEq(evals[0].count, 2, 'count is 2');
    }
  }

  section('evaluate: no-match with best similarity');
  {
    const file = '      await triggerOrderStatusChanged("a", "b", "c");\n';
    const evals = evaluateBatch(
      file,
      [{ oldText: '      await triggerOrderPrntJobd("a", "b", "c");' }],
      THRESHOLD,
      MAX_EXAMPLES,
    );
    assertEq(evals[0].kind, 'no-match', '6-char diff → no-match');
    if (evals[0].kind === 'no-match') {
      assert(evals[0].bestSimilarity > 0, 'best similarity > 0');
      assert(evals[0].bestSimilarity < THRESHOLD, 'below threshold');
      assert(evals[0].bestBlock !== null, 'best block provided');
    }
  }

  section('evaluate: max-examples limit');
  {
    // 5 literal matches, maxExamples=2 → examples array has 2
    const file = 'x\nx\nx\nx\nx\n';
    const evals = evaluateBatch(file, [{ oldText: 'x' }], THRESHOLD, 2);
    if (evals[0].kind === 'ambiguous-literal') {
      assertEq(evals[0].examples.length, 2, 'respects maxExamples');
      assertEq(evals[0].count, 5, 'but count is the real total');
    } else {
      assert(false, 'expected ambiguous-literal');
    }
  }

  section('evaluate: empty oldText');
  {
    const evals = evaluateBatch('foo', [{ oldText: '' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'no-match', 'empty oldText → no-match');
    if (evals[0].kind === 'no-match') {
      assertEq(evals[0].bestSimilarity, 0, 'best similarity 0');
    }
  }

  section('evaluate: CRLF normalization');
  {
    // CRLF in file should be normalized before matching
    const file = 'function foo() {\r\n    return 1;\r\n}\r\n';
    const evals = evaluateBatch(file, [{ oldText: '  return 1;' }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'unique-drift', 'CRLF normalized before match');
  }

  section('evaluate: CRLF in oldText matches LF in file');
  {
    // Regression: oldText coming from a Windows-style editor has CRLF. The
    // file is LF. Without line-ending normalization on the oldText side, the
    // literal match fails and the guard falsely reports 'wrong indentation'.
    const file = 'function foo() {\n    return 1;\n}\n';
    const oldTextCrlf = 'function foo() {\r\n    return 1;\r\n}\r\n';
    const evals = evaluateBatch(file, [{ oldText: oldTextCrlf }], THRESHOLD, MAX_EXAMPLES);
    assertEq(evals[0].kind, 'ok-literal', 'CRLF oldText matches LF file');
  }

  section('evaluate: no-op detected when oldText === newText');
  {
    const file = 'const a = 1;\nconst b = 2;\n';
    const evals = evaluateBatch(
      file,
      [{ oldText: 'const a = 1;', newText: 'const a = 1;' }],
      THRESHOLD,
      MAX_EXAMPLES,
    );
    assertEq(evals[0].kind, 'no-op', 'identical strings → no-op');
    if (evals[0].kind === 'no-op') {
      assertEq(evals[0].reason, 'identical-text', 'reason carried for the formatter');
    }
  }

  section('evaluate: empty oldText still falls back to no-match (not no-op)');
  {
    const evals = evaluateBatch(
      'const a = 1;\n',
      [{ oldText: '', newText: '' }],
      THRESHOLD,
      MAX_EXAMPLES,
    );
    assertEq(evals[0].kind, 'no-match', 'empty oldText → no-match, not no-op');
  }
}
