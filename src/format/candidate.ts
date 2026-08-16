/**
 * formatCandidate: format the message for a single edit that resolved to
 * `fuzzy-match` or `unique-drift` (when the latter could not be auto-fixed).
 *
 * For `fuzzy-match`: small character-level difference. The model sees the
 * file's lines verbatim plus a similarity score and copies them as its new
 * oldText.
 *
 * For `unique-drift`: pure indentation mismatch that the autofix path could
 * not silently correct (e.g. tabs in newText, non-uniform shift, defensive
 * cap exceeded). The model sees the file's actual lines and copies them
 * verbatim, plus a specific hint that names the decline reason so the model
 * can correct on the next try instead of looping.
 */

import type { AutofixDecline } from '../autofix.ts';
import type { CandidateKind } from '../types.ts';

export function formatCandidate(
  startLine: number,
  lines: string[],
  kind: CandidateKind,
  decline?: AutofixDecline,
): string {
  if (kind === 'fuzzy') {
    return formatFuzzy(startLine, lines);
  }
  if (kind === 'indentation') {
    return formatIndentation(startLine, lines, decline);
  }
  return '';
}

function formatFuzzy(startLine: number, lines: string[]): string {
  const header = `Error: Edit failed. Your oldText had a small difference from the file.`;
  const last = startLine + lines.length - 1;
  const range = `Lines ${startLine}-${last}. `;
  const instruction = `${range}Use this block verbatim as your new oldText:`;
  const body = '```\n' + lines.join('\n') + '\n```';
  return [header, '', instruction, '', body].join('\n');
}

function formatIndentation(startLine: number, lines: string[], decline?: AutofixDecline): string {
  const header = `Error: Edit failed. Indentation in your oldText didn't match the file.`;
  const last = startLine + lines.length - 1;
  const range = `Lines ${startLine}-${last}. `;
  const instruction = `${range}Use these lines verbatim as your new oldText (including leading whitespace):`;
  const body = '```\n' + lines.join('\n') + '\n```';
  const hint = decline ? formatDeclineHint(decline) : '';
  const parts = [header, '', instruction, '', body];
  if (hint) parts.push('', hint);
  return parts.join('\n');
}

/**
 * Render a single AutofixDecline as a short, model-actionable hint. Each
 * branch maps one decline reason to the corrective action the model needs
 * to take. The hint is intentionally short (one line) so it stays visible
 * even when the consolidated report is collapsed.
 */
function formatDeclineHint(decline: AutofixDecline): string {
  const line1Indexed = decline.tabLine !== undefined ? decline.tabLine + 1 : undefined;
  const lineStr = line1Indexed !== undefined ? `line ${line1Indexed}` : undefined;
  switch (decline.reason) {
    case 'missing-text':
      return '(Hint: autofix declined — oldText or newText was empty. Provide both fields.)';
    case 'line-count-mismatch':
      if (decline.mismatch) {
        return `(Hint: autofix declined — oldText has ${decline.mismatch.model} line(s) but the file block has ${decline.mismatch.file}. Match the line count.)`;
      }
      return '(Hint: autofix declined — oldText line count does not match the file block.)';
    case 'tab-in-oldtext':
      return `(Hint: autofix declined — tab character detected in oldText${lineStr ? ` at ${lineStr}` : ''}. Replace tabs with spaces.)`;
    case 'tab-in-newtext':
      return `(Hint: autofix declined — tab character detected in newText${lineStr ? ` at ${lineStr}` : ''}. Replace tabs with spaces to match the file's spaces-only indent.)`;
    case 'tab-in-file-block':
      return '(Hint: autofix declined — file uses tabs. This extension assumes spaces-only; edit the file manually or switch to spaces.)';
    case 'non-uniform-delta': {
      const l1 = decline.deltaLine !== undefined ? decline.deltaLine + 1 : undefined;
      return `(Hint: autofix declined — indent shift is not uniform across lines${l1 !== undefined ? ` (mismatch at line ${l1})` : ''}. Each non-blank line needs the same shift; check which line is off.)`;
    }
    case 'zero-delta':
      return '(Hint: autofix declined — oldText already matches the file. No change needed.)';
    case 'delta-too-large':
      if (decline.absDelta !== undefined) {
        return `(Hint: autofix declined — |delta|=${decline.absDelta} exceeds the ±50 defensive cap. The drift is too large for a silent shift; re-read the file.)`;
      }
      return '(Hint: autofix declined — drift is too large for a silent shift.)';
    default: {
      // Exhaustive fallback for future reasons.
      const _exhaustive: never = decline.reason;
      return '(Hint: autofix declined — see /tmp/pi-edit-guard-<pid>.log with PI_EDIT_GUARD_DEBUG=1.)';
    }
  }
}
