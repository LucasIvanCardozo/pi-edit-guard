/**
 * End-to-end test: load the extension via jiti (same loader Pi uses),
 * register hooks, fire events, verify hook outputs.
 *
 * This is the only test that exercises the full composition root.
 * Everything else is unit-level.
 *
 * Two paths through the tool_call hook are tested:
 * - Autofix path: unique-drift with uniform delta → mutate event.input, no block.
 * - Block path: ambiguous/fuzzy/no-match, or drift that can't be autofixed →
 *   block with consolidated report (the v0.6 behavior, still alive).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';

import { assert, assertEq, assertMatch, section } from './_framework.ts';

const jiti = createJiti(fileURLToPath(import.meta.url), {
  interopDefault: true,
  esmResolve: true,
});

export async function run(): Promise<void> {
  section('extension: loads via jiti');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const def = mod.default;
    assert(typeof def === 'function', 'default export is a function');
  }

  section('extension: registers tool_call and tool_result hooks');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const handlers: Record<string, Array<(e: unknown) => unknown>> = {
      tool_call: [],
      tool_result: [],
    };
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call' || event === 'tool_result') {
          handlers[event].push(handler);
        }
      },
    };
    mod.default(pi);
    assertEq(handlers.tool_call.length, 1, 'registers 1 tool_call handler');
    assertEq(handlers.tool_result.length, 1, 'registers 1 tool_result handler');
  }

  section('extension: tool_call autofixes indent drift (silent success)');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-autofix-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(
      testFile,
      [
        'export function SoketiClient() {',
        '      let pusherClient: Pusher | null = null;',
        '      Object.values(SOKETI_EVENTS).forEach((eventName) => {',
        '        // ... handler',
        '      });',
        '}',
      ].join('\n'),
    );

    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const event = {
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [
          {
            oldText: '  let pusherClient: Pusher | null = null;', // 2sp (wrong)
            newText: '  const target = {};', // 2sp (will be shifted to 6sp)
          },
        ],
      },
    };

    const result = await handlers[0](event);

    rmSync(dir, { recursive: true });

    assert(result === undefined, 'returns undefined (let native edit run)');
    const fixedOld = (event.input as { edits: Array<{ oldText: string }> }).edits[0].oldText;
    const fixedNew = (event.input as { edits: Array<{ newText: string }> }).edits[0].newText;
    assertEq(
      fixedOld,
      '      let pusherClient: Pusher | null = null;',
      'oldText mutated to file block (6sp)',
    );
    assertEq(fixedNew, '      const target = {};', 'newText shifted by +4 to match file indent');
  }

  section('extension: tool_call autofixes mixed ok+drift batch');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-mixed-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'const a = 1;\n    const b = 2;\n');

    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const event = {
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [
          { oldText: 'const a = 1;', newText: 'const a = 99;' }, // ok-literal
          { oldText: '  const b = 2;', newText: '  const b = 22;' }, // drift, autofixed
        ],
      },
    };

    const result = await handlers[0](event);

    rmSync(dir, { recursive: true });

    assert(result === undefined, 'returns undefined (mixed batch autofixed)');
    const edits = (event.input as { edits: Array<{ oldText: string; newText: string }> }).edits;
    assertEq(edits[0].oldText, 'const a = 1;', 'edit 1 unchanged (was ok-literal)');
    assertEq(edits[0].newText, 'const a = 99;', 'edit 1 newText unchanged');
    assertEq(edits[1].oldText, '    const b = 2;', 'edit 2 oldText mutated to file block (4sp)');
    assertEq(edits[1].newText, '    const b = 22;', 'edit 2 newText shifted to 4sp');
  }

  section('extension: tool_call atomically blocks when one edit is ambiguous');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-atomic-'));
    const testFile = join(dir, 'test.ts');
    // Two `});` lines → ambiguous-literal for edit 2 if pattern is just `});`
    writeFileSync(testFile, 'a();\n  });\nb();\n  });\n');

    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const event = {
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [
          { oldText: 'a();\n  });\nb();', newText: 'A();\n  });\nB();' }, // ok-literal
          { oldText: '  });', newText: '  }); // done' }, // ambiguous (2 matches)
        ],
      },
    };

    const result = await handlers[0](event);

    rmSync(dir, { recursive: true });

    assert(result !== undefined, 'returns a result');
    const r = result as { block: boolean; reason: string };
    assert(r.block === true, 'blocks the call (atomic)');
    assertMatch(r.reason, /Edit guard:.*1 of 2/, 'consolidated report counts the unfixable edit');
    assertMatch(r.reason, /Edit 2:.*similar blocks/, 'edit 2 reported as ambiguous');
    // Edit 1 should NOT have been mutated — atomic block means no input mutation.
    const edits = (event.input as { edits: Array<{ oldText: string; newText: string }> }).edits;
    assertEq(edits[0].oldText, 'a();\n  });\nb();', 'edit 1 input untouched (no partial fix)');
    assertEq(edits[1].oldText, '  });', 'edit 2 input untouched');
  }

  section('extension: tool_call blocks when fuzzy-match (no autofix for character diffs)');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-fuzzy-'));
    const testFile = join(dir, 'test.ts');
    // File has double digit; oldText has single digit. Same indent (4sp) so
    // normalized match fails (return 11 != return 1) but fuzzy similarity ≈ 0.92
    // → triggers fuzzy-match verdict (not drift, not no-match).
    writeFileSync(testFile, '    return 11;\n');

    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const event = {
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [{ oldText: '    return 1;', newText: '    return 99;' }],
      },
    };

    const result = await handlers[0](event);

    rmSync(dir, { recursive: true });

    assert(result !== undefined, 'returns a result');
    const r = result as { block: boolean; reason: string };
    assert(r.block === true, 'blocks the call (fuzzy is not autofixable)');
    assertMatch(r.reason, /small difference from the file/, 'fuzzy-match message');
    const edits = (event.input as { edits: Array<{ oldText: string }> }).edits;
    assertEq(edits[0].oldText, '    return 1;', 'oldText untouched (no autofix for fuzzy)');
  }

  section('extension: tool_call passes when all edits ok');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-e2e-ok-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'const a = 1;\nconst b = 2;\n');

    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const result = await handlers[0]({
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [{ oldText: 'const a = 1;' }, { oldText: 'const b = 2;' }],
      },
    });

    rmSync(dir, { recursive: true });

    assert(result === undefined, 'returns undefined when all pass');
  }

  section('extension: tool_call ignores non-edit tools');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const result = await handlers[0]({
      toolName: 'write',
      input: { path: '/tmp/foo', content: 'bar' },
    });
    assert(result === undefined, 'ignores non-edit tools');
  }

  section('extension: tool_call ignores undefined edits');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const handlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_call') handlers.push(handler);
      },
    };
    mod.default(pi);

    const result = await handlers[0]({
      toolName: 'edit',
      input: { path: undefined, edits: [] },
    });
    assert(result === undefined, 'returns undefined when path/edits missing');
  }

  section('extension: tool_result mutates error in place');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-e2e-result-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, '    return 1;\n');

    const resultHandlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_result') resultHandlers.push(handler);
      },
    };
    mod.default(pi);

    // We pass an oldText with WRONG indent (2sp) on a 4sp file → cascade sees
    // a normalized-only match. Even though our tool_call hook would have
    // autofixed this, we exercise the tool_result path with that exact
    // scenario to confirm the legacy block message still works if the model
    // somehow reaches tool_result in a non-autofix state.
    const event = {
      toolName: 'edit',
      isError: true,
      content: [{ type: 'text', text: 'Could not find the exact text' }],
      input: {
        path: testFile,
        edits: [{ oldText: '  return 1;' }], // wrong indent (2sp, file is 4sp)
      },
    };

    const result = await resultHandlers[0](event);
    rmSync(dir, { recursive: true });

    assert(result === undefined, 'returns undefined');
    assert(event.isError === false, 'mutates isError to false (quiet-tools compatible)');
    assertMatch(
      event.content[0].text,
      /Edit guard: 1 of 1 edit has issues/,
      'replaces with consolidated report',
    );
  }

  section('extension: tool_result no-op when no error');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const resultHandlers: Array<(e: unknown) => unknown> = [];
    const pi = {
      on(event: string, handler: (e: unknown) => unknown) {
        if (event === 'tool_result') resultHandlers.push(handler);
      },
    };
    mod.default(pi);

    const event = {
      toolName: 'edit',
      isError: false,
      content: [{ type: 'text', text: 'OK' }],
      input: { path: '/tmp/foo.ts', edits: [{ oldText: 'a' }] },
    };

    const result = await resultHandlers[0](event);
    assert(result === undefined, 'returns undefined when no error');
    assert(event.content[0].text === 'OK', 'content not touched');
  }
}
