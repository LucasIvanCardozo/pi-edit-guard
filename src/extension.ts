/**
 * Composition root: the default export that Pi loads.
 *
 * This file is the only place that knows about the Pi runtime. Everything
 * else in `src/` is pure and reusable. The hooks wire together config,
 * evaluation, autofix, and mutation.
 *
 * Three layers:
 *   - session_start: load auto-format config (if any) once at startup.
 *   - tool_call: intercepts BEFORE native edit runs. For each `edits[i]`:
 *       - ok-literal: pass through.
 *       - unique-drift with uniform leading-spaces shift: mutate the edit
 *         in-place so native edit runs with corrected oldText/newText.
 *         (Skipped in trust-formatter mode OR when a formatter is configured
 *         for this file — pass-through verbatim.)
 *       - everything else (fuzzy, ambiguous, no-match, drift that couldn't
 *         be autofixed): the batch is atomic-blocked with a consolidated
 *         report so the model can fix everything in one pass.
 *         (In trust-formatter / formatter-configured mode, unique-drift
 *         (any) passes through; only ambiguous/fuzzy/no-match still block.)
 *   - tool_result (error path): catches native edit failures. Re-runs the
 *       cascade on the current file state and mutates the error message
 *       in-place.
 *   - tool_result (success path, formatter): runs the configured formatter
 *       after a successful edit and rewrites `details.{patch, diff,
 *       firstChangedLine}` so the model sees `original → formatted`
 *       (never the intermediate drift state).
 *
 * Atomic semantics: when ANY edit is unfixable, NO edits are mutated. This
 * is enforced by computing autofix results first, then deciding whether to
 * apply them — only when all edits resolved.
 *
 * Trust-formatter mode (opt-in via PI_EDIT_GUARD_TRUST_FORMATTER=1 or
 * --trust-formatter CLI flag): designed for projects that run an external
 * formatter (pi-autoformat, biome, prettier) alongside. The guard skips
 * autofix entirely and passes newText verbatim to native edit; the external
 * formatter normalizes indent drift. The cascade still validates that
 * there's a match — ambiguous/fuzzy/no-match still block.
 *
 * Formatter integration (auto-format config): when a formatter is configured
 * for the file being edited (see `src/formatter-config.ts`), the same trust
 * behavior applies — autofix is skipped because the formatter will rewrite
 * the file post-edit. Plus, the success-path tool_result hook invokes the
 * formatter and rewrites details so the model sees the atomic final state.
 *
 * Debug logging: enable with `PI_EDIT_GUARD_DEBUG=1`. Each invocation of
 * `processEditInput` appends one NDJSON line to `<log-path>` with sha256 +
 * length + preview of every oldText/newText/fileContent, plus the cascade
 * verdict and autofix outcome. Full content (opt-in `PI_EDIT_GUARD_LOG_FULL`)
 * and file snapshots (opt-in `PI_EDIT_GUARD_LOG_SNAPSHOTS`) are gated
 * separately because they expose the entire file. No full content is ever
 * logged by default.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { type AutofixOutcome, type AutofixResult, tryAutofix } from './autofix.ts';
import {
  GUARDED_TOOL,
  getHintMinSimilarity,
  getMaxExamples,
  getThreshold,
  MAX_FILE_SIZE,
  shouldTrustFormatter,
} from './config.ts';
import {
  appendDebug,
  type DebugEdit,
  type DebugEvent,
  describeFile,
  describeText,
  saveFileSnapshot,
} from './debug.ts';
import { evaluateBatch } from './evaluate.ts';
import { formatConsolidatedReport } from './format/index.ts';
import {
  findFormatter,
  loadConfig,
  resolveFormatters,
  type ResolvedFormatter,
} from './formatter-config.ts';
import { generateRewriteResult } from './format/tool-result-rewriter.ts';
import { mutateToolResult } from './mutate.ts';
import { runFormatter } from './format/runner.ts';

type Edit = { oldText?: string; newText?: string };
type EditInput = { path?: string; edits?: Edit[] };

type ProcessResult =
  | { kind: 'autofixed'; corrections: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'pass' };

type ProcessOptions = {
  /** Which hook produced this invocation. Logged for correlation. */
  source: 'tool_call' | 'tool_result';
  /** Native edit error message (only present on tool_result with isError). */
  nativeError?: string;
  /**
   * When true, skip the autofix layer and pass `newText` verbatim to native
   * edit. See `shouldTrustFormatter` for the full contract.
   */
  trustFormatter?: boolean;
  /**
   * Formatter matched for this file (when set, autofix is skipped because
   * the formatter will rewrite the file post-edit). Only present at
   * `tool_call` time; resolved via `findFormatter`.
   */
  matchedFormatter?: ResolvedFormatter;
};

// ── Module-level state ────────────────────────────────────────────────────

/** Maps absolute file paths to their content before the edit tool ran. */
const originalContents = new Map<string, string>();
/** Resolved formatter config (loaded once at `session_start`). */
let resolvedFormatters: ResolvedFormatter[] = [];

/**
 * Read the file once. Run the cascade on every edit. Compute autofix for
 * each `unique-drift` edit (without mutating yet). Decide whether to:
 *   - pass through (file unreadable, oversized, or no edits)
 *   - apply all autofixes and return 'autofixed' (caller lets native edit
 *     run; inputs are mutated; every edit resolved)
 *   - return 'blocked' (any edit is unfixable; inputs are NOT mutated;
 *     atomic block semantics)
 *
 * In trust-formatter mode (`options.trustFormatter === true`):
 *   - autofix is never called; unique-drift passes through verbatim
 *   - only ambiguous / fuzzy / no-match block
 *
 * In formatter-configured mode (`options.matchedFormatter` is set):
 *   - same trust behavior as above; the formatter will normalize drift
 *     post-edit so autofix would conflict
 *   - only ambiguous / fuzzy / no-match block
 */
async function processEditInput(
  filePath: string | undefined,
  edits: Edit[] | undefined,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const debug: Partial<DebugEvent> = {
    timestamp: new Date().toISOString(),
    source: options.source,
    path: filePath,
    edits: [],
    result: 'pass',
    nativeError: options.nativeError,
  };

  if (!filePath || !edits || edits.length === 0) {
    appendDebug(debug as DebugEvent);
    return { kind: 'pass' };
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    debug.result = 'pass-unreadable';
    appendDebug(debug as DebugEvent);
    return { kind: 'pass' };
  }

  if (content.length > MAX_FILE_SIZE) {
    debug.result = 'pass-oversized';
    appendDebug(debug as DebugEvent);
    return { kind: 'pass' };
  }

  // Save a snapshot of the file when PI_EDIT_GUARD_LOG_SNAPSHOTS=1.
  // Dedupe by sha. Capped at 200/100MB. Best-effort: never throws.
  debug.snapshotPath = saveFileSnapshot(content) ?? undefined;

  const fileInfo = describeFile(content);
  debug.fileBytes = fileInfo.bytes;
  debug.fileSha = fileInfo.sha;
  debug.filePreview = fileInfo.preview;
  debug.fileLeadingNewlines = fileInfo.leadingNewlines;
  debug.fileTrailingNewlines = fileInfo.trailingNewlines;

  const threshold = getThreshold();
  const maxExamples = getMaxExamples();
  const hintMin = getHintMinSimilarity();
  const trustFormatter = options.trustFormatter === true;
  // Formatter-trust mode: a configured formatter will rewrite the file
  // post-edit, so autofix is unnecessary and would actually conflict (it
  // would mutate newText before the formatter sees it). Skip autofix
  // entirely and pass through verbatim.
  const formatterTrust = options.matchedFormatter !== undefined;

  const evaluations = evaluateBatch(content, edits, threshold, maxExamples);

  // Pass 1: compute autofix for each unique-drift edit WITHOUT mutating.
  // We need to know upfront whether each edit is resolvable, so we can
  // atomically decide to block on the whole batch if any one is unfixable.
  // In trust-formatter / formatter-configured mode, skip autofix entirely —
  // the formatter (internal or external) will normalize indent drift after
  // native edit runs.
  const autofixResults = new Map<number, AutofixResult>();
  const autofixOutcomes = new Map<number, AutofixOutcome>();
  if (!trustFormatter && !formatterTrust) {
    for (let i = 0; i < evaluations.length; i++) {
      const evaluation = evaluations[i];
      if (evaluation.kind !== 'unique-drift') continue;
      const outcome = tryAutofix(edits[i], evaluation.block);
      autofixOutcomes.set(i, outcome);
      if (outcome.ok) autofixResults.set(i, outcome.result);
      else evaluation.decline = outcome.decline;
    }
  }

  // Build the per-edit debug entries now that we know autofix outcomes.
  debug.edits = evaluations.map((evaluation, i) =>
    buildDebugEdit(edits[i], evaluation, autofixOutcomes.get(i)),
  );

  // Pass 2: is any edit unfixable? An edit is unfixable when its kind is
  // fuzzy/ambiguous/no-match, OR its kind is unique-drift but tryAutofix
  // returned null (tabs, non-uniform shift, or MAX_SANE_DELTA exceeded).
  // In trust-formatter / formatter-configured mode, unique-drift is always
  // considered resolvable (the formatter handles drift); only
  // ambiguous/fuzzy/no-match block.
  const hasUnfixableError = evaluations.some((e, i) => {
    if (e.kind === 'ok-literal') return false;
    if (e.kind === 'unique-drift') {
      // In trust mode, drift passes through; only autofix-applied drift
      // passes in default mode.
      if (trustFormatter || formatterTrust) return false;
      return !autofixResults.has(i);
    }
    return true;
  });

  if (hasUnfixableError) {
    // Atomic block: do NOT mutate any input. The caller will surface the
    // consolidated report and the model retries the whole batch.
    const report = formatConsolidatedReport(evaluations, edits.length, threshold, hintMin);
    if (report) {
      debug.result = 'blocked';
      debug.blockReasonBytes = report.length;
      appendDebug(debug as DebugEvent);
      return { kind: 'blocked', reason: report };
    }
    debug.result = 'pass';
    appendDebug(debug as DebugEvent);
    return { kind: 'pass' };
  }

  // Pass 3: every edit resolved. Apply all autofix mutations in place.
  // Native edit will run with the corrected arguments.
  // In trust-formatter / formatter-configured mode, autofixResults is
  // empty (we skipped autofix) so this loop is a no-op — newText passes
  // through verbatim, as designed.
  for (const [i, fix] of autofixResults) {
    edits[i].oldText = fix.correctedOldText;
    edits[i].newText = fix.correctedNewText;
  }

  debug.result = formatterTrust
    ? 'pass-formatter-trust'
    : trustFormatter
      ? 'pass'
      : 'autofixed';
  debug.autofixedCount = formatterTrust || trustFormatter ? undefined : autofixResults.size;
  appendDebug(debug as DebugEvent);
  return {
    kind: formatterTrust || trustFormatter ? 'pass' : 'autofixed',
    corrections: autofixResults.size,
  };
}

function buildDebugEdit(
  edit: Edit | undefined,
  evaluation: { kind: string; decline?: { reason: string } },
  outcome: AutofixOutcome | undefined,
): DebugEdit {
  const oldTextInfo = describeText(edit?.oldText ?? '');
  const newTextInfo = describeText(edit?.newText ?? '');
  const base: DebugEdit = {
    oldTextBytes: oldTextInfo.bytes,
    oldTextSha: oldTextInfo.sha,
    oldTextPreview: oldTextInfo.preview,
    oldTextLeadingSpaces: oldTextInfo.leadingSpaces,
    newTextBytes: newTextInfo.bytes,
    newTextSha: newTextInfo.sha,
    newTextPreview: newTextInfo.preview,
    newTextLeadingSpaces: newTextInfo.leadingSpaces,
    evaluationKind: evaluation.kind,
    autofixOutcome: 'n/a',
  };
  if (!outcome) return base;
  if (outcome.ok) {
    base.autofixOutcome = 'ok';
    base.autofixDelta = outcome.result.delta;
    return base;
  }
  base.autofixOutcome = 'declined';
  base.declineReason = outcome.decline.reason;
  return base;
}

export default function (pi: ExtensionAPI) {
  // Register the trust-formatter flag for discoverability (Pi auto-binds
  // it from --trust-formatter CLI arg). The actual value comes from the
  // PI_EDIT_GUARD_TRUST_FORMATTER env var (read by shouldTrustFormatter),
  // keeping the existing pattern of env-var-driven config. If the user
  // sets the CLI flag without the env var, the flag is registered but the
  // runtime value won't take effect — a documented limitation, kept simple
  // to avoid threading the flag value through every code path.
  pi.registerFlag('trust-formatter', {
    type: 'boolean',
    default: false,
    description:
      'Skip autofix; pass newText verbatim. Designed for use with an external formatter (e.g. pi-autoformat). The cascade still validates; ambiguous/fuzzy/no-match still block.',
  });

  // Resolve trust-formatter mode once at startup so processEditInput
  // doesn't read process.env per call. Cheap, but explicit.
  const trustFormatter = shouldTrustFormatter();

  // ── Hook: session_start ──────────────────────────────────────────────
  // Load auto-format config once. The presence of a config (global or
  // project) determines whether the formatter integration is active.
  // Absence = behavior identical to v0.11.0 (no formatter, autofix-only).
  pi.on('session_start', async (_event, ctx) => {
    try {
      const config = await loadConfig(ctx.cwd);
      if (!config) return;
      resolvedFormatters = resolveFormatters(config);
      if (resolvedFormatters.length > 0) {
        ctx.ui.notify(
          `[pi-edit-guard] Loaded ${resolvedFormatters.length} formatter(s)`,
          'info',
        );
      }
    } catch {
      // Best-effort: formatter load failure must never block the session.
    }
  });

  // ── Hook: tool_call ──────────────────────────────────────────────────
  // Layer 1: intercept BEFORE native edit runs.
  // Responsibilities:
  //   1. If a formatter matches this file, capture original content for
  //      the tool_result rewrite hook.
  //   2. Run cascade + autofix. When a formatter matches, skip autofix
  //      (formatter-trust mode) so the formatter sees verbatim newText.
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== GUARDED_TOOL) return;
    const input = event.input as EditInput | undefined;
    const filePath = input?.path;
    const formatter = filePath ? findFormatter(resolvedFormatters, filePath) : null;

    // Capture original content BEFORE native edit runs, so the success-path
    // tool_result hook can compute the diff from pre-edit to post-formatter.
    if (formatter && filePath) {
      const absolutePath = resolve(ctx.cwd, filePath);
      try {
        const content = await readFile(absolutePath, 'utf-8');
        originalContents.set(absolutePath, content);
      } catch {
        // File doesn't exist yet (new file); treat original as empty.
        originalContents.set(absolutePath, '');
      }
    }

    const result = await processEditInput(filePath, input?.edits, {
      source: 'tool_call',
      trustFormatter,
      matchedFormatter: formatter ?? undefined,
    });
    if (result.kind === 'blocked') {
      return { block: true, reason: result.reason };
    }
    // 'autofixed' (input already mutated) or 'pass' → let native edit run.
  });

  // ── Hook: tool_result (error path) ───────────────────────────────────
  // Layer 2: catch native edit failures and re-surface with our format.
  // Native edit is atomic: if any edit in the batch fails, the whole batch
  // returns an error. We re-run the cascade on the current file state and
  // replace the message with our richer consolidated report.
  pi.on('tool_result', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    if (!event.isError) return;
    const input = event.input as EditInput | undefined;
    // Capture what native returned so the debug log shows exactly what the
    // model saw. Truncate to keep log entries bounded. The content array
    // is a discriminated union (text | image); only text has a `text` field.
    const firstContent = event.content?.[0];
    const nativeError =
      firstContent && 'text' in firstContent && typeof firstContent.text === 'string'
        ? firstContent.text.slice(0, 500)
        : undefined;
    const result = await processEditInput(input?.path, input?.edits, {
      source: 'tool_result',
      nativeError,
      trustFormatter,
    });
    if (result.kind === 'blocked') {
      mutateToolResult(event, result.reason, false);
      return undefined;
    }
  });

  // ── Hook: tool_result (success path, formatter rewrite) ──────────────
  // Run the configured formatter after a successful edit and rewrite
  // `details.{patch, diff, firstChangedLine}` so the model sees the atomic
  // final state (original → formatted), never the intermediate drift.
  //   - Skipped when isError (no formatter run on failed edits).
  //   - Skipped when no original content was captured (no formatter matched
  //     at tool_call time, or tool_call didn't fire for this path).
  //   - Skipped when formatter exit non-zero / changed=false (keep original
  //     patch so the model still sees what actually changed).
  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== GUARDED_TOOL) return;
    if (event.isError) return;
    const input = event.input as EditInput | undefined;
    const filePath = input?.path;
    if (!filePath) return;
    const absolutePath = resolve(ctx.cwd, filePath);
    const originalContent = originalContents.get(absolutePath);
    if (originalContent === undefined) return; // no formatter matched

    // Always clean up the captured original, even when we don't rewrite.
    originalContents.delete(absolutePath);

    const formatter = findFormatter(resolvedFormatters, filePath);
    if (!formatter) return;

    let result;
    try {
      result = await runFormatter(absolutePath, formatter, pi);
    } catch (err) {
      // Best-effort: never throw from this hook.
      appendDebug({
        timestamp: new Date().toISOString(),
        source: 'tool_result',
        path: filePath,
        edits: [],
        result: 'formatter-failed',
        formatterCommand: formatter.command.join(' '),
        formatterApplied: false,
        formatterReason: 'exec-threw',
        formatterStderr: (err as Error).message.slice(0, 500),
      });
      return;
    }

    if (!result.changed) {
      appendDebug({
        timestamp: new Date().toISOString(),
        source: 'tool_result',
        path: filePath,
        edits: [],
        result: result.exitCode !== undefined ? 'formatter-failed' : 'formatter-noop',
        formatterCommand: result.command,
        formatterApplied: false,
        formatterReason:
          result.exitCode !== undefined
            ? `exit-code-${result.exitCode}`
            : 'no-change',
        formatterStderr: result.stderr || undefined,
        formatterDurationMs: result.durationMs,
      });
      return;
    }

    // Formatter changed content. Recompute patch/diff from ORIGINAL to
    // FORMATTED, so the model sees the atomic final state — never the
    // intermediate drift between newText and the formatter's output.
    const rewrite = generateRewriteResult(filePath, originalContent, result.content);
    appendDebug({
      timestamp: new Date().toISOString(),
      source: 'tool_result',
      path: filePath,
      edits: [],
      result: 'formatter-rewritten',
      formatterCommand: result.command,
      formatterApplied: true,
      formatterDurationMs: result.durationMs,
    });
    const baseDetails =
      event.details && typeof event.details === 'object'
        ? (event.details as Record<string, unknown>)
        : {};
    return {
      details: { ...baseDetails, ...rewrite.details },
    };
  });
}