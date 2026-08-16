/**
 * Post-edit formatter integration (stub — full implementation lands in v0.10.0).
 *
 * Architecture (target):
 *
 *   tool_call hook
 *     → match (cascade) + apply (autofix or verbatim)
 *     → runFormatter(filePath, content)   ← safety net for non-uniform drift
 *     → write file
 *     → block with success report
 *
 * The autofix layer handles the common case (uniform leading-space shift)
 * with zero subprocess overhead. `runFormatter` is the safety net for the
 * cases autofix declines (non-uniform-delta, tab-in-newtext, delta-too-large)
 * and for `ok-literal` / `fuzzy-match` edits where the model emitted
 * newText at the wrong indent.
 *
 * Current behavior: STUB. Returns the original content unchanged. The
 * formatter slot is wired in `extension.ts` (TODO comment) so the next
 * implementation lands cleanly without touching the cascade.
 */

/**
 * Result of a formatter invocation. `applied = false` means the formatter
 * was not invoked (not configured, file type unsupported, formatter not
 * installed, formatter failed) and `content` is the original input.
 *
 * Never throws — formatter failures are captured into `stderr` and
 * surfaced in the debug NDJSON log so the user can diagnose without
 * crashing the extension.
 */
export interface FormatterResult {
  /** True when the formatter subprocess ran and exited successfully. */
  applied: boolean;
  /** Formatted content (or original `content` if `applied` is false). */
  content: string;
  /** Captured stderr from the formatter (empty when `applied` is true). */
  stderr: string;
  /** The command that was attempted (resolved alias or full command). */
  command: string;
}

/**
 * Run the configured formatter on `content` for `filePath`.
 *
 * STUB implementation: returns `{ applied: false, content, stderr: '', command: '' }`
 * until v0.10.0 lands the subprocess wiring.
 *
 * Full implementation will:
 * 1. Resolve the formatter command via `resolveFormatterForFile(filePath)`.
 *    - Returns the stub result if no formatter configured or extension unsupported.
 * 2. Spawn the formatter as a subprocess with `filePath` as argument
 *    (or substitute `{file}` placeholder).
 * 3. Pipe `content` via stdin (so we never need to write the file before
 *    formatting — formatter reads stdin, writes stdout).
 * 4. Capture stdout as the new `content`, stderr as diagnostic.
 * 5. Timeout (5s default) → kill subprocess → return original content
 *    with stderr="timeout".
 * 6. Non-zero exit → return original content with stderr=<captured>.
 * 7. `applied = true` only on exit 0 with non-empty stdout.
 */
export async function runFormatter(_filePath: string, content: string): Promise<FormatterResult> {
  // TODO(v0.10.0): implement subprocess wiring per the contract above.
  return { applied: false, content, stderr: '', command: '' };
}
