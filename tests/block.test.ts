import { toBlockExcerpt } from '../src/block.ts';
import { assertEq, section } from './_framework.ts';

export function run(): void {
  section('block: toBlockExcerpt adapter');
  {
    const result = toBlockExcerpt({ startLine: 5, matchedLines: ['foo', 'bar'] });
    assertEq(result, { startLine: 5, lines: ['foo', 'bar'] }, 'renames matchedLines → lines');
  }
  {
    const result = toBlockExcerpt({ startLine: 1, matchedLines: [] });
    assertEq(result, { startLine: 1, lines: [] }, 'handles empty array');
  }
}
