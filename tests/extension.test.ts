/**
 * End-to-end test: load the extension via jiti (same loader Pi uses),
 * register hooks, fire events, verify the consolidated report.
 *
 * This is the only test that exercises the full composition root.
 * Everything else is unit-level.
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

  section('extension: tool_call blocks batch with consolidated report');
  {
    const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
    const dir = mkdtempSync(join(tmpdir(), 'edit-guard-e2e-'));
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

    const result = await handlers[0]({
      toolName: 'edit',
      input: {
        path: testFile,
        edits: [
          { oldText: 'let pusherClient: Pusher | null = null;' },
          { oldText: 'Object.values(SOKETI_EVENTS).forEach((eventName) => {' },
        ],
      },
    });

    rmSync(dir, { recursive: true });

    assert(result !== undefined, 'tool_call returns a result');
    const r = result as { block: boolean; reason: string };
    assert(r.block === true, 'blocks the call');
    assertMatch(r.reason, /Edit guard: 2 of 2 edits have issues/, 'consolidated header');
    assertMatch(r.reason, /Edit 1:.*Indentation in your oldText didn't match/s, 'edit 1 has drift');
    assertMatch(r.reason, /Edit 2:.*Indentation in your oldText didn't match/s, 'edit 2 has drift');
    assertMatch(r.reason, /let pusherClient: Pusher \| null = null/, "shows file's actual indent");
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

    const event = {
      toolName: 'edit',
      isError: true,
      content: [{ type: 'text', text: 'Could not find the exact text' }],
      input: {
        path: testFile,
        edits: [{ oldText: '  return 1;' }], // wrong indent
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
}
