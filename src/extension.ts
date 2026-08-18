/**
 * Composition root: the default export that Pi loads.
 *
 * This file is the only place that knows about the Pi runtime. Everything
 * else in `src/` is pure and reusable. The hooks wire together config,
 * evaluation, autofix, formatting, and mutation.
 *
 * Two layers:
 *   - tool_call: intercepts BEFORE native edit runs.
 *       For each `edits[i]`:
 *         - ok-literal: pass through.
 *         - unique-drift with uniform leading-spaces shift: mutate the edit
 *           in-place so native edit runs with corrected oldText/newText.
 *         - everything else (fuzzy, ambiguous, no-match, drift that couldn't
 *           be autofixed): the batch is atomic-blocked with a consolidated
 *           report so the model can fix everything in one pass.
 *   - tool_result: catches native edit failures. Re-runs the cascade on the
 *       current file state and mutates the error message in-place.
 *
 * Atomic semantics: when ANY edit is unfixable, NO edits are mutated. This
 * is enforced by computing autofix results first, then deciding whether to
 * apply them — only when all edits resolved.
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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { type AutofixOutcome, type AutofixResult, tryAutofix } from './autofix.ts';
import {
  GUARDED_TOOL,
  getHintMinSimilarity,
  getMaxExamples,
  getThreshold,
  MAX_FILE_SIZE,
  shouldUseRawRead,
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
import { formatConsolidatedReport, runFormatter } from './format/index.ts';
import { mutateToolResult } from './mutate.ts';
import { registerRawReadTool } from './read-override.ts';

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
};

/**
 * Read the file once. Run the cascade on every edit. Compute autofix for
 * each `unique-drift` edit (without mutating yet). Decide whether to:
 *   - pass through (file unreadable, oversized, or no edits)
 *   - apply all autofixes and return 'autofixed' (caller lets native edit
 *     run; inputs are mutated; every edit resolved)
 *   - return 'blocked' (any edit is unfixable; inputs are NOT mutated;
 *     atomic block semantics)
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
  const evaluations = evaluateBatch(content, edits, threshold, maxExamples);

  // Pass 1: compute autofix for each unique-drift edit WITHOUT mutating.
  // We need to know upfront whether each edit is resolvable, so we can
  // atomically decide to block on the whole batch if any one is unfixable.
  const autofixResults = new Map<number, AutofixResult>();
  const autofixOutcomes = new Map<number, AutofixOutcome>();
  for (let i = 0; i < evaluations.length; i++) {
    const evaluation = evaluations[i];
    if (evaluation.kind !== 'unique-drift') continue;
    const outcome = tryAutofix(edits[i], evaluation.block);
    autofixOutcomes.set(i, outcome);
    if (outcome.ok) autofixResults.set(i, outcome.result);
    else evaluation.decline = outcome.decline;
  }

  // Build the per-edit debug entries now that we know autofix outcomes.
  debug.edits = evaluations.map((evaluation, i) =>
    buildDebugEdit(edits[i], evaluation, autofixOutcomes.get(i)),
  );

  // TODO(v0.10.0): formatter safety net. After autofix resolves all edits,
  // we mutate event.input.edits and let native edit run. The formatter call
  // belongs in `tool_result` (after native succeeds) — read the file fresh,
  // resolve formatter via `resolveFormatterForFile(filePath)`, call
  // `runFormatter`, write back. For now, no-op stub; see src/format/formatter.ts.
  // When wired: add `formatterApplied` and `formatterStderr` to debug entries.
  void runFormatter;

  // Pass 2: is any edit unfixable? An edit is unfixable when its kind is
  // fuzzy/ambiguous/no-match, OR its kind is unique-drift but tryAutofix
  // returned null (tabs, non-uniform shift, or MAX_SANE_DELTA exceeded).
  const hasUnfixableError = evaluations.some((e, i) => {
    if (e.kind === 'ok-literal') return false;
    if (e.kind === 'unique-drift' && autofixResults.has(i)) return false;
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
  for (const [i, fix] of autofixResults) {
    edits[i].oldText = fix.correctedOldText;
    edits[i].newText = fix.correctedNewText;
  }

  debug.result = 'autofixed';
  debug.autofixedCount = autofixResults.size;
  appendDebug(debug as DebugEvent);
  return { kind: 'autofixed', corrections: autofixResults.size };
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
  // Layer 0 (opt-in): override the built-in `read` tool so the model receives
  // file content with exact whitespace (no TUI padding). This prevents the
  // surrender pattern where the model copies 4-space padding into edit calls.
  // Opt-out via PI_EDIT_GUARD_RAW_READ=0.
  if (shouldUseRawRead()) {
    registerRawReadTool(pi, process.cwd());
  }

  // Layer 1: intercept BEFORE native edit runs.
  pi.on('tool_call', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    const input = event.input as EditInput | undefined;
    const result = await processEditInput(input?.path, input?.edits, { source: 'tool_call' });
    if (result.kind === 'blocked') {
      return { block: true, reason: result.reason };
    }
    // 'autofixed' (input already mutated) or 'pass' → let native edit run.
  });

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
    });
    if (result.kind === 'blocked') {
      mutateToolResult(event, result.reason, false);
      return undefined;
    }
  });
}
