/**
 * Configuration: env var readers and constants.
 *
 * All values are read at call time (not at module load), so changes to
 * `process.env` between hook invocations are reflected.
 */

export const GUARDED_TOOL = 'edit';
export const DEFAULT_THRESHOLD = 0.9;
export const DEFAULT_MAX_EXAMPLES = 3;
export const DEFAULT_HINT_MIN = 0.5;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

function getIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    console.warn(`[pi-edit-guard] invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function getFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.warn(`[pi-edit-guard] invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function _getBoolEnv(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export function getThreshold(): number {
  return getFloatEnv('PI_EDIT_GUARD_THRESHOLD', DEFAULT_THRESHOLD);
}

export function getMaxExamples(): number {
  return getIntEnv('PI_EDIT_GUARD_EXAMPLES', DEFAULT_MAX_EXAMPLES);
}

export function getHintMinSimilarity(): number {
  return getFloatEnv('PI_EDIT_GUARD_HINT_MIN', DEFAULT_HINT_MIN);
}

/**
 * Path for the debug NDJSON log. Defaults to `/tmp/pi-edit-guard-<pid>.log`.
 * Snapshots (when enabled) are written to `<dirname>/<basename-without-ext>/snapshots/`
 * (e.g. `/tmp/pi-edit-guard-<pid>/snapshots/`). Only
 * consulted when `isDebugEnabled()` returns true — by default, no file is
 * created on disk.
 */
export function getLogPath(): string {
  return process.env.PI_EDIT_GUARD_LOG_PATH ?? `/tmp/pi-edit-guard-${process.pid}.log`;
}

/**
 * Master switch for the NDJSON debug log. Default OFF — no `/tmp` files
 * are created unless you opt in. Enable with `PI_EDIT_GUARD_DEBUG=1`
 * (or `true` / `yes`). When enabled, the log writes sha + length + 200-char
 * preview by default; combine with `PI_EDIT_GUARD_LOG_FULL=1` and
 * `PI_EDIT_GUARD_LOG_SNAPSHOTS=1` for richer output.
 */
export function isDebugEnabled(): boolean {
  return _getBoolEnv('PI_EDIT_GUARD_DEBUG');
}

/**
 * When true, `describeText` returns the full content in `preview` instead
 * of the 200-char preview + `[+N chars]` marker. Default OFF — the log
 * never contains full file/edit bodies unless you opt in with
 * `PI_EDIT_GUARD_LOG_FULL=1`.
 */
export function shouldLogFull(): boolean {
  return _getBoolEnv('PI_EDIT_GUARD_LOG_FULL');
}

/**
 * When true, `saveFileSnapshot` writes the file content verbatim to
 * `<log-dir>/snapshots/<sha>.orig` so it can be inspected after the fact.
 * Dedupe by sha. Capped by count and bytes. Default OFF — no snapshot
 * directory is created unless you opt in with `PI_EDIT_GUARD_LOG_SNAPSHOTS=1`.
 */
export function shouldSaveSnapshots(): boolean {
  return _getBoolEnv('PI_EDIT_GUARD_LOG_SNAPSHOTS');
}


/**
 * When true, the guard skips the autofix layer and passes `newText` verbatim
 * to native edit. Designed for projects that run an external formatter
 * (e.g. `pi-autoformat`, biome, prettier) after every edit batch — the
 * formatter cleans up indent drift that autofix would otherwise handle.
 *
 * Behavior in trust mode:
 * - `ok-literal`: pass through (no change)
 * - `unique-drift` (any kind, including non-uniform + tabs): pass through
 *   with whatever `newText` the model wrote. The external formatter will
 *   normalize the indent.
 * - `ambiguous-*` / `fuzzy-match` / `no-match`: still blocked with the
 *   consolidated report. The cascade validates; if there's no safe match,
 *   the model has to fix its `oldText` and retry.
 *
 * This mode trades the autofix safety net for a simpler mental model: the
 * guard only validates that there IS a match; it never mutates the model's
 * `newText`. If you're running pi-autoformat (or any other formatter)
 * alongside, this is the recommended setting.
 *
 * Default OFF; opt-in via `PI_EDIT_GUARD_TRUST_FORMATTER=1` (or `--trust-formatter`).
 */
export function shouldTrustFormatter(): boolean {
  return _getBoolEnv('PI_EDIT_GUARD_TRUST_FORMATTER');
}
