/**
 * Tests for the tool-result rewriter.
 *
 * Pure functions: generateRewriteResult delegates to two internal helpers
 * (generateUnifiedPatch + generateDiffString) imported from the `diff`
 * package. We assert:
 *   - patch is a unified-diff string with the file path in the header
 *   - diff is a line-numbered string with +/- prefix markers
 *   - firstChangedLine points at the first changed line of the NEW file
 *   - empty diffs are handled cleanly
 */

import { assert, assertEq, assertMatch, section } from '../_framework.ts';

import { generateRewriteResult } from '../../src/format/tool-result-rewriter.ts';

export function run(): void {
  section('rewriter: same content → empty patch, undefined firstChangedLine');

  {
    const content = 'const a = 1;\nconst b = 2;\n';
    const result = generateRewriteResult('foo.ts', content, content);
    // FILE_HEADERS_ONLY format: starts with `--- filePath`, has `+++ filePath`,
    // no `Index:` or `===` separators
    assertMatch(result.details.patch, /^--- foo\.ts/, 'patch starts with --- filePath');
    assertMatch(result.details.patch, /\+\+\+ foo\.ts/, 'patch has +++ filePath');
    assertEq(result.details.firstChangedLine, undefined, 'no first changed line');
    assertEq(result.details.diff, '', 'empty diff string when content identical');
  }

  section('rewriter: added line → diff includes +N marker');

  {
    const before = 'const a = 1;\n';
    const after = 'const a = 1;\nconst b = 2;\n';
    const result = generateRewriteResult('foo.ts', before, after);

    assertMatch(result.details.patch, /\+const b = 2/, 'patch includes added line');
    assertMatch(result.details.diff, /\+.*const b = 2/, 'diff includes added line marker');
    assertEq(result.details.firstChangedLine, 2, 'firstChangedLine is the new line number');
  }

  section('rewriter: removed line → diff includes -N marker');

  {
    const before = 'const a = 1;\nconst b = 2;\n';
    const after = 'const a = 1;\n';
    const result = generateRewriteResult('foo.ts', before, after);

    assertMatch(result.details.patch, /-const b = 2/, 'patch includes removed line');
    assertMatch(result.details.diff, /-.*const b = 2/, 'diff includes removed line marker');
    assertEq(result.details.firstChangedLine, 2, 'firstChangedLine is 2 (the line position)');
  }

  section('rewriter: changed line → diff shows both -N old and +N new');

  {
    const before = 'const a = 1;\n';
    const after = 'const a = 2;\n';
    const result = generateRewriteResult('foo.ts', before, after);

    assertMatch(result.details.patch, /-const a = 1/, 'patch shows old value');
    assertMatch(result.details.patch, /\+const a = 2/, 'patch shows new value');
    assertMatch(result.details.diff, /-.*const a = 1/, 'diff shows old value');
    assertMatch(result.details.diff, /\+.*const a = 2/, 'diff shows new value');
    assertEq(result.details.firstChangedLine, 1, 'firstChangedLine is 1');
  }

  section('rewriter: first changed line number is correct (middle of file)');

  {
    const before = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
    const after = 'line 1\nline 2\nLINE 3 MODIFIED\nline 4\nline 5\n';
    const result = generateRewriteResult('foo.ts', before, after);

    assertEq(result.details.firstChangedLine, 3, 'firstChangedLine = 3 (middle of file)');
  }

  section('rewriter: unified patch has correct filePath in header (twice)');

  {
    const result = generateRewriteResult(
      '/abs/path/to/file.ts',
      'old\n',
      'new\n',
    );
    // The patch format is `Index: filePath\n=== filePath\n--- filePath\n+++ filePath\n`
    // (Diff.createTwoFilesPatch with FILE_HEADERS_ONLY emits "Index:" prefix
    // and the path appears multiple times in the header block)
    assertMatch(
      result.details.patch,
      /^--- \/abs\/path\/to\/file\.ts/,
      'patch starts with --- absolute-path',
    );
    const pathOccurrences = (result.details.patch.match(/\/abs\/path\/to\/file\.ts/g) ?? []).length;
    assert(pathOccurrences >= 2, 'file path appears at least twice in header (--- and +++)');
  }
}