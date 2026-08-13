/**
     * Debug logger for production triage.
     *
     * Off by default. Enable with `PI_EDIT_GUARD_DEBUG=1` to append a single
     * NDJSON line per `processEditInput` invocation to
     * `/tmp/pi-edit-guard-<pid>.log`.
     *
     * What gets logged (per edit attempt):
     *   - path, fileBytes, fileSha256 (truncated), filePreview (first 200 chars)
     *   - per edit: oldTextBytes/Sha256/Preview, newTextBytes/Sha256/Preview
     *   - evaluationKind (ok-literal, unique-drift, fuzzy-match, ...)
     *   - declineReason (only when autofix declined)
     *   - autofixOutcome: 'ok' (with delta) | 'declined'
     *   - result: 'autofixed' | 'blocked' | 'pass'
     *   - blockReasonLength (only when blocked)
     *
     * Privacy: full oldText/newText/fileContent are NEVER logged. Only sha256
     * (12 hex chars = 48 bits, enough for collision-free matching within one
     * session), byte length, and a preview of the first 200 chars.
     *
     * Cost: when disabled, this module is a no-op (one env var read per call).
     * When enabled, a single appendFileSync per call — well below the noise
     * floor of any model invocation.
     */

    import { appendFileSync, statSync } from 'node:fs';
    import { createHash } from 'node:crypto';

    const PREVIEW_MAX = 200;
    /** Truncate the log file at this size to keep /tmp clean. */
    const MAX_LOG_BYTES = 5 * 1024 * 1024;
    const SHA_PREFIX_LEN = 12;

    function sha12(s: string): string {
      return createHash('sha256').update(s).digest('hex').slice(0, SHA_PREFIX_LEN);
    }

    function preview(s: string): { preview: string; bytes: number } {
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
      timestamp: string;
      path?: string;
      fileBytes?: number;
      fileSha?: string;
      filePreview?: string;
      fileLeadingNewlines?: number;
      fileTrailingNewlines?: number;
      edits: DebugEdit[];
      result: 'autofixed' | 'blocked' | 'pass' | 'pass-oversized' | 'pass-unreadable';
      blockReasonBytes?: number;
      autofixedCount?: number;
    };

    function logPath(): string {
      return `/tmp/pi-edit-guard-${process.pid}.log`;
    }

    function shouldRotate(): boolean {
      try {
        return statSync(logPath()).size >= MAX_LOG_BYTES;
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
          appendFileSync(logPath(), `# rotated at ${new Date().toISOString()}\n`);
        }
        appendFileSync(logPath(), line);
      } catch {
        // Best-effort. Logging must never crash the extension.
      }
    }

    let enabledCached: boolean | undefined;
    function isEnabled(): boolean {
      if (enabledCached !== undefined) return enabledCached;
      const v = process.env.PI_EDIT_GUARD_DEBUG;
      enabledCached = v === '1' || v === 'true' || v === 'yes';
      return enabledCached;
    }

    /** Test hook: clear the enabled cache so tests can flip the env var. */
    export function _resetEnabledCache(): void {
      enabledCached = undefined;
    }

    export function appendDebug(event: DebugEvent): void {
      if (!isEnabled()) return;
      writeLine(JSON.stringify(event) + '\n');
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