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
 */

import { readFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { type AutofixResult, tryAutofix } from './autofix.ts';
import {
  GUARDED_TOOL,
  getHintMinSimilarity,
  getMaxExamples,
  getThreshold,
  MAX_FILE_SIZE,
} from './config.ts';
import { evaluateBatch } from './evaluate.ts';
import { formatConsolidatedReport } from './format/index.ts';
import { mutateToolResult } from './mutate.ts';

type Edit = { oldText?: string; newText?: string };
type EditInput = {
  path?: string;
  edits?: Edit[];
};

type ProcessResult =
  | { kind: 'autofixed'; corrections: number }
  | { kind: 'blocked'; reason: string }
  | { kind: 'pass' };

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
): Promise<ProcessResult> {
  if (!filePath || !edits || edits.length === 0) {
    return { kind: 'pass' };
  }

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return { kind: 'pass' }; // Defer to native edit's file-not-found error.
  }

  if (content.length > MAX_FILE_SIZE) {
    return { kind: 'pass' };
  }

  const threshold = getThreshold();
  const maxExamples = getMaxExamples();
  const hintMin = getHintMinSimilarity();
  const evaluations = evaluateBatch(content, edits, threshold, maxExamples);

  // Pass 1: compute autofix for each unique-drift edit WITHOUT mutating.
  // We need to know upfront whether each edit is resolvable, so we can
  // atomically decide to block on the whole batch if any one is unfixable.
  const autofixResults = new Map<number, AutofixResult>();
  for (let i = 0; i < evaluations.length; i++) {
    const evaluation = evaluations[i];
    if (evaluation.kind !== 'unique-drift') continue;
    const fix = tryAutofix(edits[i], evaluation.block);
    if (fix !== null) autofixResults.set(i, fix);
  }

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
      return { kind: 'blocked', reason: report };
    }
    return { kind: 'pass' };
  }

  // Pass 3: every edit resolved. Apply all autofix mutations in place.
  // Native edit will run with the corrected arguments.
  for (const [i, fix] of autofixResults) {
    edits[i].oldText = fix.correctedOldText;
    edits[i].newText = fix.correctedNewText;
  }

  return { kind: 'autofixed', corrections: autofixResults.size };
}

export default function (pi: ExtensionAPI) {
  // Layer 1: intercept BEFORE native edit runs.
  pi.on('tool_call', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    const input = event.input as EditInput | undefined;
    const result = await processEditInput(input?.path, input?.edits);

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
    const result = await processEditInput(input?.path, input?.edits);
    if (result.kind === 'blocked') {
      mutateToolResult(event, result.reason, false);
      return undefined;
    }
  });
}
