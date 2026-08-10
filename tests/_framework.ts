/**
 * Test framework: a tiny dependency-free assertion library and section
 * reporter. Each test module exports a `run()` function that calls
 * `section()` and `assert*()` to register its checks.
 *
 * The runner (`tests/run.ts`) imports each test module and calls its
 * `run()` in sequence. Output is colored ✓/✗ per assertion, with a
 * summary at the end.
 */

export type TestResult = {
  section: string;
  message: string;
  passed: boolean;
};

const results: TestResult[] = [];
let currentSection = '';

export function section(name: string): void {
  currentSection = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function record(passed: boolean, message: string): void {
  results.push({ section: currentSection, message, passed });
  const marker = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${marker} ${message}`);
}

export function assert(condition: boolean, message: string): void {
  record(!!condition, message);
}

export function assertEq<T>(actual: T, expected: T, message: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
  record(ok, message);
}

export function assertMatch(value: string, regex: RegExp, message: string): void {
  const ok = regex.test(value);
  if (!ok) {
    console.log(`    value: ${JSON.stringify(value)}`);
    console.log(`    regex: ${regex.source}`);
  }
  record(ok, message);
}

export function getResults(): TestResult[] {
  return results;
}

export function printSummary(): { passed: number; failed: number } {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n\x1b[1m${'─'.repeat(60)}\x1b[0m`);
  console.log(`\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) {
    console.log(`\n\x1b[31mFailed assertions:\x1b[0m`);
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`  - [${r.section}] ${r.message}`);
    }
  }
  return { passed, failed };
}
