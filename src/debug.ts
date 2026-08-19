/**
 * Debug logger for production triage.
 *
 * Off by default. Enable with `PI_EDIT_GUARD_DEBUG=1` to append a single
 * NDJSON line per `processEditInput` invocation to the configured log path
 * (defaults to `/tmp/pi-edit-guard-<pid>.log`).
 *
 * What gets logged (per edit attempt):
 *   - source: 'tool_call' | 'tool_result' (which hook fired)
 *   - path, fileBytes, fileSha256 (truncated), filePreview (first 200 chars)
 *   - per edit: oldTextBytes/Sha256/Preview, newTextBytes/Sha256/Preview
 *   - evaluationKind (ok-literal, unique-drift, fuzzy-match, ...)
 *   - declineReason (only when autofix declined)
 *   - autofixOutcome: 'ok' (with delta) | 'declined'
 *   - result: 'autofixed' | 'blocked' | 'pass' | 'pass-oversized' | 'pass-unreadable'
 *   - blockReasonBytes (only when blocked)
 *   - nativeError: native edit error message (only when tool_result fires with isError)
 *   - snapshotPath: path to saved file snapshot (only when PI_EDIT_GUARD_LOG_SNAPSHOTS=1)
 *
 * Privacy (default): full oldText/newText/fileContent are NEVER logged. Only sha256
 * (12 hex chars = 48 bits, enough for collision-free matching within one
 * session), byte length, and a preview of the first 200 chars.
 *
 * Opt-in: `PI_EDIT_GUARD_LOG_FULL=1` returns the entire content in `preview`
 * instead of truncating. `PI_EDIT_GUARD_LOG_SNAPSHOTS=1` writes the file
 * content verbatim to `<log-dir>/snapshots/<sha>.orig` for offline inspection.
 *
 * Cost: when disabled, this module is a no-op (one env var read per call).
 * When enabled, a single appendFileSync per call — well below the noise
 * floor of any model invocation.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { getLogPath, isDebugEnabled, shouldLogFull, shouldSaveSnapshots } from './config.ts';

const PREVIEW_MAX = 200;
/** Truncate the log file at this size to keep /tmp clean. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const SHA_PREFIX_LEN = 12;
/** Maximum number of file snapshots to keep on disk. */
const MAX_SNAPSHOTS = 200;
/** Maximum total bytes of file snapshots. */
const MAX_SNAPSHOTS_BYTES = 100 * 1024 * 1024;

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, SHA_PREFIX_LEN);
}

function preview(s: string): { preview: string; bytes: number } {
  // Full-content opt-in: return the entire string when PI_EDIT_GUARD_LOG_FULL=1.
  // Off by default because the content may be sensitive.
  if (shouldLogFull()) {
    return { preview: s, bytes: s.length };
  }
  if (s.length <= PREVIEW_MAX) return { preview: s, bytes: s.length };
  return {
    preview: `${s.slice(0, PREVIEW_MAX)}...[+${s.length - PREVIEW_MAX} chars]`,
    bytes: s.length,
  };
}

export type DebugEdit = {
  oldTextBytes: number;
  oldTextSha: string;
  oldTextPreview: string;
  oldTextLeadingSpaces: number;
  newTextBytes: number;
  newTextSha: string;
  newTextPreview: string;
  newTextLeadingSpaces: number;
  evaluationKind: string;
  declineReason?: string;
  autofixOutcome: 'ok' | 'declined' | 'n/a';
  autofixDelta?: number;
};

export type DebugEvent = {
  /** Which hook produced this event. */
  source?: 'tool_call' | 'tool_result';
  timestamp: string;
  path?: string;
  fileBytes?: number;
  fileSha?: string;
  filePreview?: string;
  fileLeadingNewlines?: number;
  fileTrailingNewlines?: number;
  edits: DebugEdit[];
  result: 'autofixed' | 'blocked' | 'pass' | 'pass-oversized' | 'pass-unreadable' | 'pass-formatter-trust' | 'formatter-rewritten' | 'formatter-noop' | 'formatter-failed';
  blockReasonBytes?: number;
  autofixedCount?: number;
  /** Path to a saved file snapshot under `<log-dir>/snapshots/`. */
  snapshotPath?: string;
  /** Native edit error message (only when tool_result fires with isError). */
  nativeError?: string;
  /** Resolved formatter command (only on tool_result formatter events). */
  formatterCommand?: string;
  /** True when the formatter actually changed the file content. */
  formatterApplied?: boolean;
  /** Brief reason when formatter was skipped, failed, or no-op. */
  formatterReason?: string;
  /** Truncated stderr (only when formatter exited non-zero). */
  formatterStderr?: string;
  /** Wall-clock duration of the formatter run. */
  formatterDurationMs?: number;
};

function snapshotsDir(): string {
  return join(dirname(getLogPath()), 'snapshots');
}

function shouldRotate(): boolean {
  try {
    return statSync(getLogPath()).size >= MAX_LOG_BYTES;
  } catch {
    return false;
  }
}

function writeLine(line: string): void {
  try {
    if (shouldRotate()) {
      // Truncate by overwriting with the new line. The previous line set is
      // discarded — we keep the LAST batch of events, which is what matters
      // for triage.
      appendFileSync(getLogPath(), `# rotated at ${new Date().toISOString()}\n`);
    }
    appendFileSync(getLogPath(), line);
  } catch {
    // Best-effort. Logging must never crash the extension.
  }
}

let enabledCached: boolean | undefined;
function isEnabled(): boolean {
  if (enabledCached !== undefined) return enabledCached;
  enabledCached = isDebugEnabled();
  return enabledCached;
}

/** Test hook: clear the enabled cache so tests can flip the env var. */
export function _resetEnabledCache(): void {
  enabledCached = undefined;
}

export function appendDebug(event: DebugEvent): void {
  if (!isEnabled()) return;
  writeLine(`${JSON.stringify(event)}\n`);
}

/**
 * Save a snapshot of the file content to `<log-dir>/snapshots/<sha>.orig`.
 *
 * - Returns null when `PI_EDIT_GUARD_LOG_SNAPSHOTS` is unset, content is empty,
 *   or the filesystem write fails. Never throws — best-effort.
 * - Dedupe by sha: same content → same path, no rewrite.
 * - Cap by count (200) and bytes (100MB): oldest by mtime get pruned.
 *
 * The returned path is intended to be stored in `DebugEvent.snapshotPath`
 * so an offline reader can `cat` the file and see exactly what the model
 * was looking at.
 */
export function saveFileSnapshot(content: string): string | null {
  if (!shouldSaveSnapshots()) return null;
  if (!content) return null;
  const sha = sha12(content);
  const dir = snapshotsDir();
  const filePath = join(dir, `${sha}.orig`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content);
      pruneSnapshots(dir);
    }
    return filePath;
  } catch {
    return null;
  }
}

function pruneSnapshots(dir: string): void {
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith('.orig'))
      .map((name) => {
        const full = join(dir, name);
        const st = statSync(full);
        return { path: full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const kept: Array<{ path: string; size: number }> = [];
    let totalBytes = 0;
    for (const e of entries) {
      if (
        kept.length >= MAX_SNAPSHOTS ||
        (kept.length > 0 && totalBytes + e.size > MAX_SNAPSHOTS_BYTES)
      ) {
        try {
          unlinkSync(e.path);
        } catch {
          // ignore — file may have been removed concurrently
        }
      } else {
        kept.push(e);
        totalBytes += e.size;
      }
    }
  } catch {
    // best-effort; pruning failures must never crash the extension
  }
}

/** Helpers used by extension.ts to build the event fields. */
export function describeText(s: string): {
  bytes: number;
  sha: string;
  preview: string;
  leadingSpaces: number;
} {
  const p = preview(s);
  return {
    bytes: p.bytes,
    sha: sha12(s),
    preview: p.preview,
    leadingSpaces: s.length === 0 ? 0 : (s.match(/^( *)/)?.[0].length ?? 0),
  };
}

export function describeFile(content: string): {
  bytes: number;
  sha: string;
  preview: string;
  leadingNewlines: number;
  trailingNewlines: number;
} {
  const p = preview(content);
  return {
    bytes: p.bytes,
    sha: sha12(content),
    preview: p.preview,
    leadingNewlines: content.length === 0 ? 0 : (content.match(/^\n*/)?.[0].length ?? 0),
    trailingNewlines: content.length === 0 ? 0 : (content.match(/\n*$/)?.at(0)?.length ?? 0),
  };
}
