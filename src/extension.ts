/**
 * Composition root: the default export that Pi loads.
 *
 * This file is the only place that knows about the Pi runtime. Everything
 * else in `src/` is pure and reusable. The hooks wire together config,
 * evaluation, formatting, and mutation.
 *
 * Two layers:
 *   - tool_call: intercepts BEFORE native edit runs. If any edit in the
 *     batch has an issue, block the entire batch with a consolidated report
 *     so the model can fix it in one pass.
 *   - tool_result: catches native edit failures. Re-runs the cascade on the
 *     current file state and mutates the error message in-place.
 */

import { readFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

type EditInput = {
  path?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
};

/**
 * Read the file, run the cascade, format the consolidated report. Returns
 * `null` when the file is missing, too large, or all edits pass.
 *
 * Shared by the tool_call and tool_result hooks. The two layers differ
 * only in how they deliver the report (block vs mutate), not in how
 * they build it.
 */
async function processEditInput(
  filePath: string | undefined,
  edits: Array<{ oldText?: string; newText?: string }> | undefined,
): Promise<string | null> {
  if (!filePath || !edits || edits.length === 0) return null;

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null; // Defer to native edit's file-not-found error.
  }

  if (content.length > MAX_FILE_SIZE) return null;

  const threshold = getThreshold();
  const maxExamples = getMaxExamples();
  const hintMin = getHintMinSimilarity();
  const evaluations = evaluateBatch(content, edits, threshold, maxExamples);
  return formatConsolidatedReport(evaluations, edits.length, threshold, hintMin);
}

export default function (pi: ExtensionAPI) {
  // Layer 1: intercept BEFORE native edit runs. If any edit in the batch
  // has an issue, block the entire batch with the consolidated report.
  pi.on('tool_call', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    const input = event.input as EditInput | undefined;
    const report = await processEditInput(input?.path, input?.edits);
    if (report) {
      return { block: true, reason: report };
    }
  });

  // Layer 2: catch native edit failures. Native edit is atomic: if any
  // edit in the batch fails, the whole batch returns an error. We re-run
  // the cascade on the current file state and replace the message with
  // our richer consolidated report.
  pi.on('tool_result', async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    if (!event.isError) return;
    const input = event.input as EditInput | undefined;
    const report = await processEditInput(input?.path, input?.edits);
    if (report) {
      mutateToolResult(event, report, false);
      return undefined;
    }
  });
}
