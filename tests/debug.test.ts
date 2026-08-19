/**
 * Tests for the debug logger (`src/debug.ts`).
 *
 * The debug logger defaults to ON (writes NDJSON to
 * `/tmp/pi-edit-guard-<pid>.log`). All three flags are opt-out:
 *   - PI_EDIT_GUARD_DEBUG=0       silence the log entirely
 *   - PI_EDIT_GUARD_LOG_FULL=0    redact to sha + length + preview
 *   - PI_EDIT_GUARD_LOG_SNAPSHOTS=0   skip file snapshots
 *
 * These tests verify:
 *   1. Default-on behavior for all three flags.
 *   2. Opt-out works via `=0` / `false` / `no`.
 *   3. NDJSON shape includes `source` and `nativeError` fields.
 *   4. Snapshot dedupe by sha, cap by count, custom log path, FS error tolerance.
 */

import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  _resetEnabledCache,
  appendDebug,
  describeFile,
  describeText,
  saveFileSnapshot,
} from '../src/debug.ts';
import { assert, assertEq, section } from './_framework.ts';

const LOG_PATH = `/tmp/pi-edit-guard-${process.pid}.log`;
const SNAPSHOTS_DIR = join(dirname(LOG_PATH), 'snapshots');

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  _resetEnabledCache();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
    _resetEnabledCache();
  }
}

function clearLog(): void {
  try {
    unlinkSync(LOG_PATH);
  } catch {
    // ignore
  }
}

function clearSnapshots(): void {
  try {
    rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
  } catch {
    // ignore
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

export function run(): void {
  section('debug: ON by default; opt-out via PI_EDIT_GUARD_DEBUG=0');
  clearLog();
  withEnv('PI_EDIT_GUARD_DEBUG', undefined, () => {
    appendDebug({
      timestamp: '2024-01-01T00:00:00Z',
      edits: [],
      result: 'pass',
    });
  });
  assert(existsSync(LOG_PATH), 'log file created when env unset (default on)');

  clearLog();
  withEnv('PI_EDIT_GUARD_DEBUG', '0', () => {
    appendDebug({
      timestamp: '2024-01-01T00:00:00Z',
      edits: [],
      result: 'pass',
    });
  });
  assert(!existsSync(LOG_PATH), 'log file NOT created when env=0');

  section('debug: explicit PI_EDIT_GUARD_DEBUG=1 still works (redundant with default)');
  {
    clearLog();
    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
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

  section('debug: false and no also disable');
  clearLog();
  withEnv('PI_EDIT_GUARD_DEBUG', 'false', () => {
    appendDebug({ timestamp: '2024-01-01T00:00:00Z', edits: [], result: 'pass' });
  });
  assert(!existsSync(LOG_PATH), 'env=false disables');

  clearLog();
  withEnv('PI_EDIT_GUARD_DEBUG', 'no', () => {
    appendDebug({ timestamp: '2024-01-01T00:00:00Z', edits: [], result: 'pass' });
  });
  assert(!existsSync(LOG_PATH), 'env=no disables');

  section('debug: full content logged by default; PI_EDIT_GUARD_LOG_FULL=0 redacts');
  {
    clearLog();
    const bigOldText = '  return 1;\n'.repeat(100); // 1100+ bytes
    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
      appendDebug({
        timestamp: '2024-01-01T00:00:00Z',
        path: '/tmp/test.ts',
        edits: [
          {
            oldTextBytes: bigOldText.length,
            oldTextSha: 'placeholder',
            oldTextPreview: bigOldText,
            oldTextLeadingSpaces: 2,
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
    const rawLog = readFileSync(LOG_PATH, 'utf-8');
    // JSON.stringify escapes newlines as \\n; raw log has escaped form.
    // Needle mirrors the source string (with the leading two spaces).
    assert(
      rawLog.includes('  return 1;\\n'.repeat(50)),
      'full content present by default (escaped newlines)',
    );

    clearLog();
    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
      withEnv('PI_EDIT_GUARD_LOG_FULL', '0', () => {
        const oldTextInfo = describeText(bigOldText);
        appendDebug({
          timestamp: '2024-01-01T00:00:00Z',
          path: '/tmp/test.ts',
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
    });
    const redactedLog = readFileSync(LOG_PATH, 'utf-8');
    assert(
      !redactedLog.includes('  return 1;\\n'.repeat(50)),
      'full content absent when LOG_FULL=0',
    );
    assert(redactedLog.includes('[+'), 'truncation marker present when redacted');
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

  section('debug: describeText preview is full by default; LOG_FULL=0 truncates at 200 chars');
  {
    const long = 'x'.repeat(500);
    withEnv('PI_EDIT_GUARD_LOG_FULL', undefined, () => {
      const info = describeText(long);
      assertEq(info.bytes, 500, 'bytes accurate');
      assertEq(info.preview, long, 'preview is the full content (default on)');
    });
    withEnv('PI_EDIT_GUARD_LOG_FULL', '0', () => {
      const info = describeText(long);
      assert(info.preview.startsWith('x'.repeat(200)), 'starts with 200 x chars when redacted');
      assert(info.preview.includes('[+300 chars]'), 'indicates remaining length when redacted');
      assertEq(info.bytes, 500, 'byte count is full length');
    });
  }

  section('debug: source field round-trips through NDJSON');
  {
    clearLog();
    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
      appendDebug({
        timestamp: '2024-01-01T00:00:00Z',
        source: 'tool_call',
        edits: [],
        result: 'pass',
      });
      appendDebug({
        timestamp: '2024-01-01T00:00:01Z',
        source: 'tool_result',
        nativeError: 'No changes made. The replacement produced identical content.',
        edits: [],
        result: 'pass',
      });
    });
    const lines = readLogLines();
    assertEq(lines.length, 2, 'two events written');
    assertEq(lines[0].source, 'tool_call', 'first event tagged tool_call');
    assertEq(lines[1].source, 'tool_result', 'second event tagged tool_result');
    assert(
      (lines[1].nativeError as string).includes('No changes made'),
      'nativeError captured verbatim',
    );
  }

  section('debug: source field omitted when not provided');
  {
    clearLog();
    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
      appendDebug({
        timestamp: '2024-01-01T00:00:00Z',
        edits: [],
        result: 'pass',
      });
    });
    const lines = readLogLines();
    assert(!('source' in lines[0]), 'source field absent when not passed');
  }

  section('debug: snapshot SAVED by default; PI_EDIT_GUARD_LOG_SNAPSHOTS=0 disables');
  clearLog();
  clearSnapshots();
  withEnv('PI_EDIT_GUARD_LOG_SNAPSHOTS', undefined, () => {
    const result = saveFileSnapshot('hello world');
    assert(result !== null, 'returns a path when env unset (default on)');
    assert(existsSync(result!), 'snapshot file actually created by default');
  });

  clearSnapshots();
  withEnv('PI_EDIT_GUARD_LOG_SNAPSHOTS', '0', () => {
    const result = saveFileSnapshot('hello world');
    assertEq(result, null, 'returns null when env=0');
  });
  assert(!existsSync(SNAPSHOTS_DIR), 'snapshots dir not created when disabled');

  section('debug: snapshot full content round-trip');
  {
    clearLog();
    clearSnapshots();
    const content = 'const x = 1;\nconst y = 2;\n';
    const path = saveFileSnapshot(content);
    assert(path !== null, 'returns a path when env var on');
    assert(path!.endsWith('.orig'), 'file extension is .orig');
    assert(existsSync(path!), 'snapshot file actually created');
    const written = readFileSync(path!, 'utf-8');
    assertEq(written, content, 'snapshot content matches input verbatim');
  }

  section('debug: snapshot dedupe by sha — same content → same file');
  {
    clearSnapshots();
    const first = saveFileSnapshot('alpha-content');
    const second = saveFileSnapshot('alpha-content');
    assertEq(first, second, 'returns same path for same content');
    const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.orig'));
    assertEq(files.length, 1, 'only one snapshot file for identical content');
  }

  section('debug: snapshot dedupe — different content → different files');
  {
    clearSnapshots();
    saveFileSnapshot('content-A');
    saveFileSnapshot('content-B');
    const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.orig'));
    assertEq(files.length, 2, 'two snapshots for two distinct contents');
  }

  section('debug: snapshot handles empty content');
  {
    clearSnapshots();
    const result = saveFileSnapshot('');
    assertEq(result, null, 'empty content → no snapshot');
  }

  section('debug: PI_EDIT_GUARD_LOG_PATH overrides default log path');
  {
    clearLog();
    const customPath = '/tmp/peg-test-custom-path.log';
    try {
      unlinkSync(customPath);
    } catch {}
    try {
      rmSync(join(dirname(customPath), 'snapshots'), { recursive: true, force: true });
    } catch {}

    withEnv('PI_EDIT_GUARD_DEBUG', '1', () => {
      withEnv('PI_EDIT_GUARD_LOG_PATH', customPath, () => {
        appendDebug({
          timestamp: '2024-01-01T00:00:00Z',
          edits: [],
          result: 'pass',
        });
        const snapPath = saveFileSnapshot('custom-snapshot-content');
        assert(
          snapPath!.includes(dirname(customPath)),
          'snapshot dir derived from custom log path',
        );
        assert(existsSync(snapPath!), 'snapshot written under custom path');
      });
    });

    assert(existsSync(customPath), 'log written to custom path');
    assert(!existsSync(LOG_PATH), 'default log path not used');

    try {
      unlinkSync(customPath);
    } catch {}
    try {
      rmSync(join(dirname(customPath), 'snapshots'), { recursive: true, force: true });
    } catch {}
  }

  section('debug: snapshot handles filesystem errors gracefully');
  {
    try {
      rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
    } catch {}
    writeFileSync(SNAPSHOTS_DIR, 'I am a regular file, not a directory.');
    const result = saveFileSnapshot('cannot-write-here');
    assertEq(result, null, 'returns null when mkdir/write fails');
    try {
      unlinkSync(SNAPSHOTS_DIR);
    } catch {}
  }

  section('debug: helpers expose expected public API');
  assert(typeof _resetEnabledCache === 'function', '_resetEnabledCache exported');
  assert(typeof appendDebug === 'function', 'appendDebug exported');
  assert(typeof describeText === 'function', 'describeText exported');
  assert(typeof describeFile === 'function', 'describeFile exported');
  assert(typeof saveFileSnapshot === 'function', 'saveFileSnapshot exported');
}
