/**
 * Test runner: imports every test module and runs them in sequence.
 *
 * Each test module exports a `run()` function. We call them in a
 * deterministic order: matchers first (lowest-level), then evaluate, then
 * format, then extension (e2e). The summary is printed at the end.
 *
 * If any test fails, the process exits with code 1.
 */

import { printSummary } from './_framework.ts';
import * as autofixTests from './autofix.test.ts';
import * as blockTests from './block.test.ts';
import * as debugTests from './debug.test.ts';
import * as evaluateTests from './evaluate.test.ts';
import * as extensionTests from './extension.test.ts';
import * as formatTests from './format.test.ts';
import * as fuzzyMatcherTests from './matchers/fuzzy.test.ts';
import * as literalMatcherTests from './matchers/literal.test.ts';
import * as normalizedMatcherTests from './matchers/normalized.test.ts';
import * as readOverrideTests from './read-override.test.ts';
import * as whitespaceTests from './whitespace.test.ts';

whitespaceTests.run();
readOverrideTests.run();
debugTests.run();
blockTests.run();
literalMatcherTests.run();
normalizedMatcherTests.run();
fuzzyMatcherTests.run();
autofixTests.run();
evaluateTests.run();
formatTests.run();
await extensionTests.run();

const { failed } = printSummary();
if (failed > 0) {
  process.exit(1);
}
