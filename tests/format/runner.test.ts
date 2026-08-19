/**
 * Tests for the formatter runner.
 *
 * Uses real temp files (so `readFile` works naturally) and a fake `pi.exec`
 * (so we can simulate exit codes / failures without spawning a real
 * subprocess).
 *
 * The fake binary is mocked via the `exec` function — we never actually
 * spawn a real formatter. We just verify that `runFormatter` returns the
 * correct `FormatterRunResult` shape for each scenario.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { assert, assertEq, assertMatch, section } from '../_framework.ts';

import {
  type FormatterRunResult,
  runFormatter,
} from '../../src/format/runner.ts';
import type { ResolvedFormatter } from '../../src/formatter-config.ts';

interface FakePiOptions {
  /** code returned by the fake exec (default 0). */
  exitCode?: number;
  /** stderr returned by the fake exec. */
  stderr?: string;
  /** set true to throw from exec (simulates unsupported API). */
  throw?: boolean;
}

function makeFakePi(options: FakePiOptions): {
  pi: ExtensionAPI;
  execCalls: Array<{ command: string; args: string[]; opts: unknown }>;
} {
  const execCalls: Array<{ command: string; args: string[]; opts: unknown }> = [];
  const pi = {
    exec: async (
      command: string,
      args: string[],
      opts: unknown,
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      execCalls.push({ command, args, opts });
      if (options.throw) {
        throw new Error('exec not supported');
      }
      return {
        code: options.exitCode ?? 0,
        stdout: '',
        stderr: options.stderr ?? '',
      };
    },
  } as unknown as ExtensionAPI;
  return { pi, execCalls };
}

function makeFormatter(): ResolvedFormatter {
  return {
    name: 'fake',
    command: ['fake-bin', '--write'],
  };
}

export async function run(): Promise<void> {
  section('runner: success, file changed → returns changed=true + content');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-changed-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'const a=1\n');

    const { pi, execCalls } = makeFakePi({ exitCode: 0 });
    // Simulate the formatter writing to disk: rewrite file content in the
    // fake exec to mimic what a real formatter would do.
    const originalExec = pi.exec;
    (pi as { exec: typeof originalExec }).exec = async (
      cmd: string,
      args: string[],
      opts: unknown,
    ) => {
      const result = await originalExec(cmd, args, opts);
      // Pretend the formatter normalized the file
      writeFileSync(testFile, 'const a = 1\n');
      return result;
    };

    const result = await runFormatter(testFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assert(result.changed === true, 'changed=true when content differs');
    assertEq(result.content, 'const a = 1\n', 'returns formatted content');
    assertEq(result.exitCode, undefined, 'no exitCode on success');
    assertEq(result.stderr, '', 'empty stderr on success');
    assertEq(result.command, 'fake-bin --write', 'records command');
    assertMatch(result.durationMs.toString(), /^\d+$/, 'durationMs is a number');
    assertEq(execCalls.length, 1, 'one exec call');
    assertEq(execCalls[0].command, 'fake-bin', 'passes command[0]');
    assertEq(execCalls[0].args[0], '--write', 'passes command[1] as first arg');
    assertEq(execCalls[0].args[execCalls[0].args.length - 2], '--', 'passes -- separator');
    assertEq(execCalls[0].args[execCalls[0].args.length - 1], testFile, 'passes file path last');
  }

  section('runner: success, file unchanged → returns changed=false');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-unchanged-'));
    const testFile = join(dir, 'test.ts');
    const original = 'const a = 1\n';
    writeFileSync(testFile, original);

    const { pi } = makeFakePi({ exitCode: 0 });
    // Formatter runs but doesn't modify the file.
    const result: FormatterRunResult = await runFormatter(testFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assert(result.changed === false, 'changed=false when content identical');
    assertEq(result.content, original, 'returns content (unchanged)');
    assertEq(result.exitCode, undefined, 'no exitCode on success');
  }

  section('runner: exit non-zero → returns stderr + exitCode, never throws');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-fail-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'broken syntax');

    const { pi } = makeFakePi({ exitCode: 2, stderr: 'syntax error on line 5' });
    const result = await runFormatter(testFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assert(result.changed === false, 'changed=false on non-zero exit');
    assertEq(result.exitCode, 2, 'records exit code');
    assertMatch(result.stderr, /syntax error/, 'captures stderr');
    assert(result.durationMs >= 0, 'records duration even on failure');
  }

  section('runner: exec throws → returns captured error, never propagates');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-throw-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'const a = 1\n');

    const { pi } = makeFakePi({ throw: true });
    const result = await runFormatter(testFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assert(result.changed === false, 'changed=false when exec throws');
    assertMatch(result.stderr, /exec failed/, 'captures the thrown error message');
    assertEq(result.exitCode, undefined, 'no exitCode when exec threw');
  }

  section('runner: file does not exist → returns error, never throws');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-missing-'));
    const missingFile = join(dir, 'does-not-exist.ts');

    const { pi } = makeFakePi({ exitCode: 0 });
    const result = await runFormatter(missingFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assert(result.changed === false, 'changed=false when file missing');
    assertMatch(result.stderr, /cannot read file/, 'reports read error');
    assertEq(result.content, '', 'empty content on read failure');
  }

  section('runner: timeout passed to pi.exec');

  {
    const dir = mkdtempSync(join(tmpdir(), 'pi-edit-guard-runner-timeout-'));
    const testFile = join(dir, 'test.ts');
    writeFileSync(testFile, 'const a = 1\n');

    const { pi, execCalls } = makeFakePi({ exitCode: 0 });
    await runFormatter(testFile, makeFormatter(), pi);
    rmSync(dir, { recursive: true });

    assertEq(execCalls.length, 1, 'one exec call');
    const opts = execCalls[0].opts as { timeout?: number } | undefined;
    assert(opts && typeof opts.timeout === 'number', 'exec was called with options');
    assert(opts.timeout === 5000, 'timeout is 5000ms (5s)');
  }
}