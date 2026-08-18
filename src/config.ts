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


/**
 * When true, the built-in `read` tool is overridden with a minimal renderer
 * that hides the file content by default. The user sees only `read <path>`
 * (no syntax highlighting, no content preview); the model receives the
 * full, unaltered file content via the built-in `execute()` path.
 *
 * This is the fix for the TUI padding problem: the built-in render adds ~4
 * spaces of leading whitespace per line that the model mistakes for actual
 * file content. When the model copies those 4 spaces into an `edit` call's
 * `oldText`, the edit fails because the file doesn't have them. The raw
 * override eliminates the padding at the source instead of relying on the
 * guard to silently fix it after the fact.
 *
 * Default ON (opt-out via `PI_EDIT_GUARD_RAW_READ=0`). Reasoning: this is
 * the primary fix for the surrender pattern. Users who want the built-in
 * visual rendering can opt out. The user can still see the file content
 * by pressing Ctrl+O to expand, or by using bash/grep for visual reads.
 */
export function shouldUseRawRead(): boolean {
  return !isEnvFalsy('PI_EDIT_GUARD_RAW_READ');
}

/**
 * Optional post-edit formatter command. When unset (default), no formatter
 * runs after the edit — the autofix path covers uniform-shift drift, and
 * non-uniform cases fall through to the consolidated block.
 *
 * When set, the guard runs the formatter on the file after every successful
 * edit batch. This is the "safety net" for cases the autofix declines
 * (non-uniform-delta, tab-in-newtext, delta-too-large). Two forms:
 *
 * - Full command: `prettier --write`, `black --quiet`, `gofmt -w`, etc.
 *   The file path is appended if no `{file}` placeholder is present.
 * - Bare alias: `biome`, `prettier`, `black`, `gofmt`, `rustfmt`. Resolved
 *   by file extension via `resolveFormatterForFile`.
 *
 * Set to `0` / `false` / `no` to disable explicitly even if a stale alias
 * leaks in. Unknown aliases resolve to null (no formatter runs).
 */
export function getFormatterCommand(): string | null {
  const raw = process.env.PI_EDIT_GUARD_FORMATTER;
  if (!raw) return null;
  if (raw === '0' || raw === 'false' || raw === 'no') return null;
  return raw;
}

/**
 * Map of file extension → default formatter alias. Used when
 * `PI_EDIT_GUARD_FORMATTER` is set to a bare alias like `biome`.
 *
 * The alias here is the COMMAND NAME (without args). `runFormatter` resolves
 * it to the actual command per file at call time. Add to this map as the
 * project supports more languages.
 */
const FORMATTER_ALIASES: Record<string, string> = {
  '.ts': 'biome',
  '.tsx': 'biome',
  '.js': 'biome',
  '.jsx': 'biome',
  '.mjs': 'biome',
  '.cjs': 'biome',
  '.json': 'biome',
  '.css': 'biome',
  '.scss': 'biome',
  '.graphql': 'biome',
  '.md': 'biome',
  '.py': 'black',
  '.go': 'gofmt',
  '.rs': 'rustfmt',
};

/**
 * Resolve the formatter command for a specific file. Returns null when:
 * - formatter not configured
 * - extension has no alias (e.g. `.txt`, `.lock`)
 * - extension is unknown
 *
 * For a bare alias (`PI_EDIT_GUARD_FORMATTER=biome`), returns the resolved
 * command for the file's extension. For a full command
 * (`PI_EDIT_GUARD_FORMATTER="prettier --write"`), returns the command as-is.
 */
export function resolveFormatterForFile(filePath: string): string | null {
  const cmd = getFormatterCommand();
  if (!cmd) return null;
  // Full command (contains spaces or args): use as-is.
  if (cmd.includes(' ')) return cmd;
  // Bare alias: look up by extension.
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  const resolved = FORMATTER_ALIASES[ext];
  return resolved ?? null;
}
