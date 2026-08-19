/**
 * Composition root: the default export that Pi loads.
 *
 * This file is the only place that knows about the Pi runtime. Everything
 * else in `src/` is pure and reusable. The hooks wire together config,
 * evaluation, autofix, and mutation.
 *
 * Two layers:
 *   - tool_call: intercepts BEFORE native edit runs.
 *       For each `edits[i]`:
 *         - ok-literal: pass through.
 *         - unique-drift with uniform leading-spaces shift: mutate the edit
 *           in-place so native edit runs with corrected oldText/newText.
 *           (Skipped in trust-formatter mode — pass-through verbatim.)
 *         - everything else (fuzzy, ambiguous, no-match, drift that couldn't
 *           be autofixed): the batch is atomic-blocked with a consolidated
 *           report so the model can fix everything in one pass.
 *           (In trust-formatter mode, unique-drift (any) passes through;
 *           only ambiguous/fuzzy/no-match still block.)
 *   - tool_result: catches native edit failures. Re-runs the cascade on the
 *       current file state and mutates the error message in-place.
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
import { mutateToolResult } from './mutate.ts';

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
};

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

  const evaluations = evaluateBatch(content, edits, threshold, maxExamples);

  // Pass 1: compute autofix for each unique-drift edit WITHOUT mutating.
  // We need to know upfront whether each edit is resolvable, so we can
  // atomically decide to block on the whole batch if any one is unfixable.
  // In trust-formatter mode, skip autofix entirely — the external formatter
  // (e.g. pi-autoformat) will normalize indent drift after native edit runs.
  const autofixResults = new Map<number, AutofixResult>();
  const autofixOutcomes = new Map<number, AutofixOutcome>();
  if (!trustFormatter) {
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
  // In trust-formatter mode, unique-drift is always considered resolvable
  // (the external formatter handles drift); only ambiguous/fuzzy/no-match
  // block.
  const hasUnfixableError = evaluations.some((e, i) => {
    if (e.kind === 'ok-literal') return false;
    if (e.kind === 'unique-drift') {
      // In trust mode, drift passes through; only autofix-applied drift
      // passes in default mode.
      if (trustFormatter) return false;
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
  // In trust-formatter mode, autofixResults is empty (we skipped autofix) so
  // this loop is a no-op — newText passes through verbatim, as designed.
  for (const [i, fix] of autofixResults) {
    edits[i].oldText = fix.correctedOldText;
    edits[i].newText = fix.correctedNewText;
  }

  debug.result = trustFormatter ? 'pass' : 'autofixed';
  debug.autofixedCount = trustFormatter ? undefined : autofixResults.size;
  appendDebug(debug as DebugEvent);
  return {
    kind: trustFormatter ? 'pass' : 'autofixed',
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

  // Layer 1: intercept BEFORE native edit runs.
  pi.on('tool_call', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    const input = event.input as EditInput | undefined;
    const result = await processEditInput(input?.path, input?.edits, {
      source: 'tool_call',
      trustFormatter,
    });
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
      trustFormatter,
    });
    if (result.kind === 'blocked') {
      mutateToolResult(event, result.reason, false);
      return undefined;
    }
  });
}
