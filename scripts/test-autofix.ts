/**
 * End-to-end test against real files in /tmp.
 *
 * Loads the extension via jiti (same loader Pi uses), creates a temp file
 * with realistic content, simulates a `tool_call` event with the same shape
 * Pi emits, and inspects what the extension does:
 *   - does it return undefined (auto-fix mutated input, native edit would run)?
 *   - does it return { block: true, reason: ... } (atomic block)?
 *   - did the input get mutated as expected?
 *
 * Usage:
 *   node --experimental-strip-types scripts/test-autofix.ts
 *
 * Optional: --verbose to print the full consolidated report and (when block
 * does not happen) the proposed new file content.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');

const jiti = createJiti(fileURLToPath(import.meta.url), {
  interopDefault: true,
  esmResolve: true,
});

const mod = jiti(join(HERE, '..', 'index.ts'));
const extension = mod.default;

let testCount = 0;
let passCount = 0;

function section(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function assertEq(actual: unknown, expected: unknown, label: string) {
  testCount++;
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${label}`);
    passCount++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
  }
}

function assertMatches(actual: unknown, predicate: (x: unknown) => boolean, label: string) {
  testCount++;
  if (predicate(actual)) {
    console.log(`  ✓ ${label}`);
    passCount++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`    actual: ${JSON.stringify(actual)}`);
  }
}

async function simulateToolCall(filePath: string, edits: Array<{ oldText: string; newText: string }>) {
  const handlers: Array<(e: unknown) => unknown> = [];
  const pi = {
    on(event: string, handler: (e: unknown) => unknown) {
      if (event === 'tool_call') handlers.push(handler);
    },
  };
  extension(pi);

  const event = {
    toolName: 'edit',
    input: { path: filePath, edits },
  };

  const result = await handlers[0](event);
  return { result, event };
}

function showFile(filePath: string) {
  const content = readFileSync(filePath, 'utf-8');
  console.log('  File contents:');
  for (const line of content.split('\n')) {
    console.log(`    ${line.length === 0 ? '(empty)' : line}`);
  }
}

type Scenario = {
  name: string;
  fileContent: string;
  edits: Array<{ oldText: string; newText: string }>;
  assertions: (event: { toolName: string; input: { path: string; edits: Array<{ oldText: string; newText: string }> } }, result: unknown) => void;
};

async function runScenario(label: string, scenario: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'peg-test-'));
  const file = join(dir, 'sample.ts');
  writeFileSync(file, scenario.fileContent);

  section(label);
  showFile(file);

  const { result, event } = await simulateToolCall(file, scenario.edits);

  scenario.assertions(event, result);

  if (VERBOSE) {
    console.log('  --- result ---');
    console.log(`  ${JSON.stringify(result, null, 2).replace(/\n/g, '\n  ')}`);
    console.log('  --- input after extension ---');
    console.log(`  ${JSON.stringify(event.input, null, 2).replace(/\n/g, '\n  ')}`);
  }

  rmSync(dir, { recursive: true });
}

async function main() {
  // ───────────────────────────────────────────────────────────────────────
  // Scenario 1: carta-qr style — model sends 2sp, file has 0sp
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 1: carta-qr style (model 2sp, file 0sp)', {
    fileContent: [
      '### Operations',
      '',
      '- [Realtime](docs/operations/realtime.md) — Soketi env URLs.',
      '- [Soketi deploy](docs/operations/soketi-deploy.md) — IPv6.',
      '- [Soketi rotate](docs/operations/soketi-rotate.md) — 90 days.',
    ].join('\n'),
    edits: [
      {
        oldText: '  - [Realtime](docs/operations/realtime.md) — Soketi env URLs.\n  - [Soketi deploy](docs/operations/soketi-deploy.md) — IPv6.\n  - [Soketi rotate](docs/operations/soketi-rotate.md) — 90 days.',
        newText: '  - [Realtime](docs/operations/realtime.md) — Soketi env URLs, cache + trigger ordering.\n  - [Soketi deploy](docs/operations/soketi-deploy.md) — IPv6 resolution.\n  - [Soketi rotate](docs/operations/soketi-rotate.md) — secrets rotation every 90 days.',
      },
    ],
    assertions: (event, result) => {
      assertEq(result, undefined, 'no block — autofix succeeded');
      assertEq(
        event.input.edits[0].oldText,
        '- [Realtime](docs/operations/realtime.md) — Soketi env URLs.\n- [Soketi deploy](docs/operations/soketi-deploy.md) — IPv6.\n- [Soketi rotate](docs/operations/soketi-rotate.md) — 90 days.',
        'oldText mutated to file block (0sp)',
      );
      assertEq(
        event.input.edits[0].newText,
        '- [Realtime](docs/operations/realtime.md) — Soketi env URLs, cache + trigger ordering.\n- [Soketi deploy](docs/operations/soketi-deploy.md) — IPv6 resolution.\n- [Soketi rotate](docs/operations/soketi-rotate.md) — secrets rotation every 90 days.',
        'newText shifted by -2 spaces uniformly',
      );
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 2: settings.json style — model has correct indent, edit fails
  // because of unrelated issue (here we simulate via fuzzy mismatch)
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 2: off-by-one character (fuzzy decline, no autofix)', {
    fileContent: '    return 11;\n',
    edits: [
      { oldText: '    return 1;', newText: '    return 99;' },
    ],
    assertions: (_event, result) => {
      assertMatches(result, (r) => r && typeof r === 'object' && 'block' in r && r.block === true, 'returns block (fuzzy is not autofixable)');
      const r = result as { block: boolean; reason: string };
      assertMatches(r, (x) => /small difference from the file/.test((x as { reason: string }).reason), 'reason mentions fuzzy match');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 3: positive delta (need to add spaces)
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 3: positive delta (+2 spaces, deeply nested)', {
    fileContent: [
      'export function connect() {',
      '      const client = new Client();',
      '      client.connect();',
      '}',
    ].join('\n'),
    edits: [
      {
        oldText: '  const client = new Client();',
        newText: '  const client = Client.connect();',
      },
    ],
    assertions: (event, result) => {
      assertEq(result, undefined, 'autofix succeeded');
      assertEq(event.input.edits[0].oldText, '      const client = new Client();', 'oldText → 6sp');
      assertEq(event.input.edits[0].newText, '      const client = Client.connect();', 'newText shifted to 6sp');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 4: negative delta (need to remove spaces)
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 4: negative delta (-4 spaces)', {
    fileContent: [
      'function setup() {',
      '  return initial();',
      '}',
    ].join('\n'),
    edits: [
      {
        oldText: '    return initial();',
        newText: '    return initial(); // done',
      },
    ],
    assertions: (event, result) => {
      assertEq(result, undefined, 'autofix succeeded');
      assertEq(event.input.edits[0].oldText, '  return initial();', 'oldText → 2sp');
      assertEq(event.input.edits[0].newText, '  return initial(); // done', 'newText shifted to 2sp');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 5: tabs in file — autofix declines, falls back to block
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 5: tabs in file (autofix declines)', {
    fileContent: 'function foo() {\n\treturn 1;\n}\n',
    edits: [
      { oldText: '    return 1;', newText: '    return 2;' },
    ],
    assertions: (event, result) => {
      assertMatches(result, (r) => r && typeof r === 'object' && 'block' in r && r.block === true, 'returns block (tabs in file)');
      const r = result as { reason: string };
      assertMatches(r, (x) => /Indentation in your oldText didn't match/.test((x as { reason: string }).reason), 'reason shows indent-mismatch message');
      assertEq(event.input.edits[0].oldText, '    return 1;', 'oldText NOT mutated (tab case)');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 6: non-uniform delta — autofix declines
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 6: non-uniform delta (autofix declines)', {
    fileContent: [
      '  if (x) {',
      '    return 1;',
      '  }',
    ].join('\n'),
    edits: [
      {
        // Line 1: model 2sp, file 2sp → delta 0
        // Line 2: model 2sp, file 4sp → delta +2
        // Line 3: model 2sp, file 2sp → delta 0
        // → non-uniform, autofix declines
        oldText: '  if (x) {\n  return 1;\n  }',
        newText: '  if (x) {\n  return 2;\n  }',
      },
    ],
    assertions: (event, result) => {
      assertMatches(result, (r) => r && typeof r === 'object' && 'block' in r && r.block === true, 'returns block (non-uniform)');
      assertEq(event.input.edits[0].oldText, '  if (x) {\n  return 1;\n  }', 'oldText NOT mutated (non-uniform decline)');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 7: mixed batch — ok + drift + ambiguous → atomic block
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 7: atomic block when one edit is ambiguous', {
    fileContent: [
      'export function a() {',
      '  func1();',
      '  func2();',
      '  func3();',
      '}',
    ].join('\n'),
    edits: [
      // Edit 1: ok-literal
      { oldText: '  func1();', newText: '  func1(true);' },
      // Edit 2: drift, but autocorrected
      { oldText: '    func2();', newText: '    func2(true);' },
      // Edit 3: ambiguous (literal "  func" appears 3 times)
      { oldText: '  func', newText: '  method' },
    ],
    assertions: (event, result) => {
      assertMatches(result, (r) => r && typeof r === 'object' && 'block' in r && r.block === true, 'returns block (atomic)');
      assertEq(event.input.edits[0].oldText, '  func1();', 'edit 1 NOT mutated (atomic block)');
      assertEq(event.input.edits[1].oldText, '    func2();', 'edit 2 NOT mutated (atomic block)');
    },
  });

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 8: happy batch — all edits resolve (ok + drift)
  // ───────────────────────────────────────────────────────────────────────
  await runScenario('Scenario 8: happy batch (ok + drift, all resolve)', {
    fileContent: [
      'const a = 1;',
      '        const b = 2;',
    ].join('\n'),
    edits: [
      { oldText: 'const a = 1;', newText: 'const a = 99;' },
      { oldText: '  const b = 2;', newText: '  const b = 22;' },
    ],
    assertions: (event, result) => {
      assertEq(result, undefined, 'no block');
      assertEq(event.input.edits[0].oldText, 'const a = 1;', 'edit 1 untouched (was ok-literal)');
      assertEq(event.input.edits[1].oldText, '        const b = 2;', 'edit 2 oldText → 8sp');
      assertEq(event.input.edits[1].newText, '        const b = 22;', 'edit 2 newText shifted to 8sp');
    },
  });

  console.log('\n' + '-'.repeat(60));
  console.log(`Results: ${passCount}/${testCount} passed`);
  if (passCount < testCount) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
