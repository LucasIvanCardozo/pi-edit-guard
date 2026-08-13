/**
     * Tests for the debug logger (`src/debug.ts`).
     *
     * The debug logger is opt-in via `PI_EDIT_GUARD_DEBUG=1` and writes NDJSON
     * to `/tmp/pi-edit-guard-<pid>.log`. These tests verify:
     *   1. Off by default — no file written without env var.
     *   2. On when env var is set — file written, parseable NDJSON.
     *   3. Redacción — full content is never logged; only sha + length + preview.
     *   4. Helpers — describeText, describeFile, appendDebug all behave correctly.
     */

    import { existsSync, readFileSync, unlinkSync } from 'node:fs';

    import { _resetEnabledCache, appendDebug, describeFile, describeText } from '../src/debug.ts';
    import { assert, assertEq, section } from './_framework.ts';

    const LOG_PATH = `/tmp/pi-edit-guard-${process.pid}.log`;

    function withEnv(value: string | undefined, fn: () => void): void {
      const prev = process.env.PI_EDIT_GUARD_DEBUG;
      if (value === undefined) delete process.env.PI_EDIT_GUARD_DEBUG;
      else process.env.PI_EDIT_GUARD_DEBUG = value;
      _resetEnabledCache();
      try {
        fn();
      } finally {
        if (prev === undefined) delete process.env.PI_EDIT_GUARD_DEBUG;
        else process.env.PI_EDIT_GUARD_DEBUG = prev;
        _resetEnabledCache();
      }
    }

    function readLogLines(): Array<Record<string, unknown>> {
      if (!existsSync(LOG_PATH)) return [];
      const text = readFileSync(LOG_PATH, 'utf-8');
      return text
        .split('\n')
        .filter((l) => l.length > 0 && !l.startsWith('#'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }

    function clearLog(): void {
      try {
        unlinkSync(LOG_PATH);
      } catch {
        // ignore
      }
    }

    export function run(): void {
      section('debug: off by default');
      {
        clearLog();
        withEnv(undefined, () => {
          appendDebug({
            timestamp: '2024-01-01T00:00:00Z',
            edits: [],
            result: 'pass',
          });
        });
        assert(!existsSync(LOG_PATH), 'no log file created when PI_EDIT_GUARD_DEBUG is unset');
      }

      section('debug: enabled via PI_EDIT_GUARD_DEBUG=1');
      {
        clearLog();
        withEnv('1', () => {
          appendDebug({
            timestamp: '2024-01-01T00:00:00Z',
            edits: [],
            result: 'pass',
          });
        });
        const lines = readLogLines();
        assertEq(lines.length, 1, 'one line written');
        assertEq(lines[0].result, 'pass', 'round-trip via NDJSON preserves fields');
      }

      section('debug: appendDebug no-op when disabled');
      {
        clearLog();
        withEnv('0', () => {
          appendDebug({
            timestamp: '2024-01-01T00:00:00Z',
            edits: [],
            result: 'pass',
          });
        });
        assert(!existsSync(LOG_PATH), 'env value other than 1/true/yes does not enable');
      }

      section('debug: redact full content, only sha + length + preview');
      {
        clearLog();
        const bigOldText = '  return 1;\n'.repeat(100); // 1100+ bytes
        const bigFileContent = 'const x = 1;\n'.repeat(200);
        withEnv('1', () => {
          const oldTextInfo = describeText(bigOldText);
          const fileInfo = describeFile(bigFileContent);
          appendDebug({
            timestamp: '2024-01-01T00:00:00Z',
            path: '/tmp/test.ts',
            fileBytes: fileInfo.bytes,
            fileSha: fileInfo.sha,
            filePreview: fileInfo.preview,
            edits: [
              {
                oldTextBytes: oldTextInfo.bytes,
                oldTextSha: oldTextInfo.sha,
                oldTextPreview: oldTextInfo.preview,
                oldTextLeadingSpaces: oldTextInfo.leadingSpaces,
                newTextBytes: 0,
                newTextSha: 'na',
                newTextPreview: '',
                newTextLeadingSpaces: 0,
                evaluationKind: 'unique-drift',
                autofixOutcome: 'declined',
                declineReason: 'tab-in-newtext',
              },
            ],
            result: 'blocked',
          });
        });

        // Verify the full bigOldText does NOT appear anywhere in the log
        const rawLog = readFileSync(LOG_PATH, 'utf-8');
        assert(!rawLog.includes('return 1;\n'.repeat(50)), 'full content NOT present in log');
        assert(!rawLog.includes('const x = 1;\n'.repeat(50)), 'full file content NOT present in log');

        const lines = readLogLines();
        assertEq(lines.length, 1, 'one event written');
        const edit = (lines[0].edits as Array<Record<string, unknown>>)[0];
        assertEq(edit.oldTextBytes, bigOldText.length, 'byte count preserved');
        assertEq((edit.oldTextSha as string).length, 12, 'sha truncated to 12 hex chars');
        assert(
          (edit.oldTextPreview as string).includes('[+'),
          'preview includes length marker for truncated content',
        );
        assertEq(edit.declineReason, 'tab-in-newtext', 'decline reason preserved');
        assertEq(edit.autofixOutcome, 'declined', 'autofix outcome preserved');
      }

      section('debug: describeText counts leading spaces');
      {
        const info = describeText('    hello');
        assertEq(info.leadingSpaces, 4, '4 leading spaces');
        assertEq(info.bytes, 9, '9 bytes total');
        assertEq(info.preview, '    hello', 'short text not truncated');
        assertEq(info.sha.length, 12, 'sha truncated');
      }

      section('debug: describeText handles empty string');
      {
        const info = describeText('');
        assertEq(info.leadingSpaces, 0, '0 leading spaces for empty');
        assertEq(info.bytes, 0, '0 bytes for empty');
        assertEq(info.preview, '', 'empty preview');
      }

      section('debug: describeFile counts leading and trailing newlines');
      {
        const info = describeFile('\n\nfoo\n\n');
        assertEq(info.leadingNewlines, 2, '2 leading newlines');
        assertEq(info.trailingNewlines, 2, '2 trailing newlines');
      }

      section('debug: preview truncates long content at 200 chars');
      {
        const long = 'x'.repeat(500);
        const info = describeText(long);
        assert(info.preview.startsWith('x'.repeat(200)), 'starts with 200 x chars');
        assert(info.preview.includes('[+300 chars]'), 'indicates remaining length');
        assertEq(info.bytes, 500, 'byte count is full length');
      }
    }