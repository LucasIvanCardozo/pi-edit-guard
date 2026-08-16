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

function getBoolEnv(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Returns true when the env var is explicitly set to a falsy value
 * (`0` / `false` / `no`). Used to flip opt-in flags into opt-out: the
 * default is "feature on"; only an explicit falsy value disables it.
 */
function isEnvFalsy(name: string): boolean {
  const v = process.env[name];
  return v === '0' || v === 'false' || v === 'no';
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
 * Snapshots (when enabled) are written to `<dirname>/snapshots/`.
 */
export function getLogPath(): string {
  return process.env.PI_EDIT_GUARD_LOG_PATH ?? `/tmp/pi-edit-guard-${process.pid}.log`;
}

/**
 * Master switch for the NDJSON debug log. Default ON; set to `0` / `false`
 * / `no` to silence the log. The log writes sha + length + preview by
 * default; combine with `PI_EDIT_GUARD_LOG_FULL` and `PI_EDIT_GUARD_LOG_SNAPSHOTS`
 * for richer output.
 */
export function isDebugEnabled(): boolean {
  return !isEnvFalsy('PI_EDIT_GUARD_DEBUG');
}

/**
 * When true, `describeText` returns the full content in `preview` instead
 * of the 200-char preview + `[+N chars]` marker. Default ON; set to `0`
 * to redact to sha + length + preview only.
 */
export function shouldLogFull(): boolean {
  return !isEnvFalsy('PI_EDIT_GUARD_LOG_FULL');
}

/**
 * When true, `saveFileSnapshot` writes the file content verbatim to
 * `<log-dir>/snapshots/<sha>.orig` so it can be inspected after the fact.
 * Dedupe by sha. Capped by count and bytes. Default ON; set to `0` to
 * skip snapshots and keep only the structured log.
 */
export function shouldSaveSnapshots(): boolean {
  return !isEnvFalsy('PI_EDIT_GUARD_LOG_SNAPSHOTS');
}