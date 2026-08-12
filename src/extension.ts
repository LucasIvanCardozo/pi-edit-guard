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
 */

import { readFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { tryAutofix } from './autofix.ts';
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
 * Read the file once. Run the cascade on every edit. Try to autofix each
 * `unique-drift` verdict. Decide whether to:
 *   - pass through (file unreadable, oversized, or no edits)
 *   - return 'autofixed' (caller lets native edit run; some inputs were
 *     mutated, none block)
 *   - return 'blocked' (caller blocks with consolidated report; atomic
 *     semantics — if any one edit is unfixable, the whole batch is blocked)
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

  // Pass 1: try to autofix each unique-drift edit, mutating in place.
  const autofixed = new Set<number>();
  for (let i = 0; i < evaluations.length; i++) {
    const evaluation = evaluations[i];
    if (evaluation.kind !== 'unique-drift') continue;
    const edit = edits[i];
    const fix = tryAutofix(edit, evaluation.block);
    if (fix === null) continue;
    edit.oldText = fix.correctedOldText;
    edit.newText = fix.correctedNewText;
    autofixed.add(i);
  }

  // Pass 2: if any verdict remains unfixable, block atomically. An edit is
  // considered resolved when it is ok-literal OR was autofixed in Pass 1.
  const hasUnfixableError = evaluations.some((e, i) => {
    if (e.kind === 'ok-literal') return false;
    if (e.kind === 'unique-drift' && autofixed.has(i)) return false;
    return true;
  });

  if (!hasUnfixableError) {
    return { kind: 'autofixed', corrections: autofixed.size };
  }

  const report = formatConsolidatedReport(evaluations, edits.length, threshold, hintMin);
  if (report) {
    return { kind: 'blocked', reason: report };
  }
  return { kind: 'pass' };
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
