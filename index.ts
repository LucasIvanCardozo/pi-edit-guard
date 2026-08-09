/**
 * pi-edit-guard
 *
 * Wraps Pi's native `edit` tool with two-layer protection against the most
 * common LLM failure mode in code editing: indentation drift.
 *
 * Layer 1 (tool_call): intercepts BEFORE native edit runs. Blocks with our
 * message when:
 *   - oldText appears literally > 1 times in the file (uniqueness check
 *     that native edit does internally and aborts with its own message), OR
 *   - oldText has 0 literal occurrences but exactly 1 normalized match
 *     (unambiguous indentation drift). This proactively returns the
 *     correctly-indented block before the native edit fails, so the model
 *     gets a clear actionable error instead of looping.
 *
 * Layer 2 (tool_result): catches native edit failures (exact match not found)
 * that escape Layer 1 (e.g., 0 literal + 0 normalized matches, then native
 * fuzzy failure). Runs the same normalized/exact + fuzzy cascade as a
 * fallback to enrich the error with the most probable target block.
 *
 * The extension NEVER writes to the file. It only enriches error messages
 * (and blocks ambiguous cases at the tool_call layer). It also mutates
 * `event.content` in-place (instead of returning a patch) so that other
 * extensions registering custom renderers (e.g. gentle-pi's quiet-tools) see
 * our enriched message instead of the original native error.
 *
 * Algorithm cascade for tool_result:
 *   1. Whitespace-normalized exact match (per-line strip of leading spaces/tabs)
 *      - if 1 unique match, return it with similarity 1.00
 *      - if multiple exact normalized matches, return "ambiguous, re-read"
 *      - if 0 matches, advance to step 2
 *   2. Diff-based char-level Levenshtein per line, averaged
 *      - sliding window with similarity threshold (default 0.90)
 *      - if 1 candidate above threshold, return it
 *      - if multiple above threshold, return "ambiguous, re-read"
 *      - if 0 above threshold, return "no match" (with best-match hint)
 *
 * Configuration (env vars):
 *   PI_EDIT_GUARD_THRESHOLD  similarity threshold 0..1, default 0.90
 *
 * Install:
 *   pi install npm:pi-edit-guard
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";

const GUARDED_TOOL = "edit";
const DEFAULT_THRESHOLD = 0.9;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────

function getThreshold(): number {
  const raw = process.env.PI_EDIT_GUARD_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.warn(
      `[pi-edit-guard] invalid PI_EDIT_GUARD_THRESHOLD="${raw}", using default ${DEFAULT_THRESHOLD}`,
    );
    return DEFAULT_THRESHOLD;
  }
  return parsed;
}

// ──────────────────────────────────────────────────────────────────────────
// Whitespace helpers
// ──────────────────────────────────────────────────────────────────────────

function stripLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, "");
}

function normalizeText(text: string): string {
  return text.split("\n").map(stripLeadingWhitespace).join("\n");
}

/**
 * Compact indent descriptor for minimal token usage.
 *   "    code" → "4sp"
 *   "\t\tcode" → "2tb"
 *   "  \tcode" → "2sp+1tb"
 *   "code"     → "-"
 */
function describeIndent(line: string): string {
  const match = line.match(/^([ \t]+)/);
  if (!match) return "-";
  const indent = match[1];
  const spaces = (indent.match(/ /g) || []).length;
  const tabs = (indent.match(/\t/g) || []).length;
  if (spaces > 0 && tabs > 0) return `${spaces}sp+${tabs}tb`;
  if (spaces > 0) return `${spaces}sp`;
  if (tabs > 0) return `${tabs}tb`;
  return "-";
}

function padRight(str: string, width: number): string {
  return str + " ".repeat(Math.max(0, width - str.length));
}

/**
 * Muta event.content e event.isError in-place para reemplazar el resultado del tool.
 *
 * Por qué mutamos en vez de retornar un patch:
 *   Las extensions como `quiet-tools` registran custom rendering que lee
 *   `result.content` directamente (no el patch acumulado). Si retornamos un
 *   patch `{ content: [...] }`, Pi crea un nuevo objeto y el renderer ve el
 *   contenido original. Mutando in-place, los renderers custom ven nuestro
 *   mensaje directamente.
 *
 *   También muteamos isError a `false` para que quiet-tools colapse el output
 *   (con COLLAPSED_TAIL_LINE_LIMIT) en vez de mostrar el error completo.
 *   El modelo sigue viendo todo el content (la mutación no recorta nada).
 */
function mutateToolResult(
  event: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  newText: string,
  isError: boolean,
): void {
  if (Array.isArray(event.content) && event.content.length > 0) {
    event.content[0] = { type: "text", text: newText };
  } else {
    event.content = [{ type: "text", text: newText }];
  }
  event.isError = isError;
}

// ──────────────────────────────────────────────────────────────────────────
// Response formatting (compact, no redundancies)
// ──────────────────────────────────────────────────────────────────────────

type CandidateKind = "indentation" | "fuzzy";

function formatCandidate(
  _startLine: number,
  lines: string[],
  kind: CandidateKind,
): string {
  const reason =
    kind === "indentation"
      ? "Your oldText had wrong indentation"
      : "Your oldText had a small difference from the file";

  const header = `Error: Edit failed. ${reason}.\n`;
  const instruction = "Use this block as your new oldText in your next edit call:\n";

  const labels = lines.map(describeIndent);
  const hasSpaces = labels.some((l) => l.includes("sp"));
  const hasTabs = labels.some((l) => l.includes("tb"));
  const legend =
    hasSpaces && hasTabs ? "sp = spaces, tb = tabs\n" : "";

  const body = "```\n" + lines.join("\n") + "\n```";

  return `${header}${legend ? legend + "\n" : ""}${instruction}\n${body}`;
}

function formatMultipleMatches(count: number, threshold: number): string {
  return (
    `Found ${count} similar blocks.\n` +
    `Re-read the file and provide a more specific oldText that uniquely identifies the target block.`
  );
}

function formatNoMatch(_bestSimilarity: number, _threshold: number): string {
  return (
    `No sufficiently similar block found.\n` +
    `Re-read the file to see its current contents before retrying.`
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Matching algorithms
// ──────────────────────────────────────────────────────────────────────────

function findNormalizedMatches(
  fileContent: string,
  normalizedOldText: string,
): Array<{ startLine: number; matchedLines: string[] }> {
  // Guard defensivo: empty string causa infinite loop en indexOf
  if (!normalizedOldText || normalizedOldText.trim() === "") return [];

  const fileLines = fileContent.split("\n");
  const normalizedFileLines = fileLines.map(stripLeadingWhitespace);
  const normalizedFile = normalizedFileLines.join("\n");

  const oldTextLineCount = normalizedOldText.split("\n").length;
  const matches: Array<{ startLine: number; matchedLines: string[] }> = [];

  let pos = 0;
  while ((pos = normalizedFile.indexOf(normalizedOldText, pos)) !== -1) {
    const before = normalizedFile.substring(0, pos);
    const startLine = before.split("\n").length - 1;
    const matchedLines = fileLines.slice(startLine, startLine + oldTextLineCount);
    matches.push({ startLine: startLine + 1, matchedLines });
    pos += normalizedOldText.length;
  }

  return matches;
}

function levenshteinDistance<T>(
  a: T[],
  b: T[],
  equals: (x: T, y: T) => boolean,
): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (equals(a[i - 1], b[j - 1])) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function lineCharSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a && !b) return 1;
  const dist = levenshteinDistance(a.split(""), b.split(""), (x, y) => x === y);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function findFuzzyMatches(
  fileContent: string,
  oldText: string,
  threshold: number,
): Array<{ startLine: number; matchedLines: string[]; similarity: number }> {
  const fileLines = fileContent.split("\n");
  const oldTextLines = oldText.split("\n").map(stripLeadingWhitespace);
  const windowSize = oldTextLines.length;

  if (windowSize === 0 || windowSize > fileLines.length) return [];

  const candidates: Array<{
    startLine: number;
    matchedLines: string[];
    similarity: number;
  }> = [];

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines.slice(i, i + windowSize).map(stripLeadingWhitespace);
    let totalSim = 0;
    for (let j = 0; j < windowSize; j++) {
      totalSim += lineCharSimilarity(oldTextLines[j], window[j]);
    }
    const similarity = totalSim / windowSize;

    if (similarity >= threshold) {
      candidates.push({
        startLine: i + 1,
        matchedLines: fileLines.slice(i, i + windowSize),
        similarity,
      });
    }
  }

  return candidates;
}

// ──────────────────────────────────────────────────────────────────────────
// Extension entry
// ──────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Layer 1: intercept BEFORE native edit runs. Block ambiguous matches and
  // unambiguously-failing indentation mismatches so the model gets a clear
  // error message at the moment of the failed call, not after the native
  // edit returns its own (less informative) failure.
  pi.on("tool_call", async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;

    const input = event.input as {
      path?: string;
      edits?: Array<{ oldText?: string }>;
    } | undefined;
    const filePath = input?.path;
    const oldText = input?.edits?.[0]?.oldText;

    if (!filePath || !oldText) return;

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return; // Dejar pasar al nativo (preserva su error de file not found, etc.)
    }

    if (content.length > MAX_FILE_SIZE) return;

    // Cuenta literal (substring match, igual que el edit nativo)
    const occurrences = content.split(oldText).length - 1;

    if (occurrences > 1) {
      // Bloquear con NUESTRO mensaje en vez del nativo "Found N occurrences"
      return {
        block: true,
        reason: formatMultipleMatches(occurrences, 1.0),
      };
    }

    if (occurrences === 0) {
      // 0 ocurrencias literales: chequear si es un drift de indentación
      // (match normalized exacto). Si lo es, bloquear proactivamente con
      // el bloque correcto para que el modelo no quede en loop esperando
      // el error del native edit.
      const normalizedFileContent = content.replace(/\r\n/g, "\n");
      const normalizedOldText = normalizeText(oldText.replace(/\r\n/g, "\n"));

      if (normalizedOldText.length > 0) {
        const normalizedMatches = findNormalizedMatches(
          normalizedFileContent,
          normalizedOldText,
        );

        if (normalizedMatches.length === 1) {
          const m = normalizedMatches[0];
          return {
            block: true,
            reason: formatCandidate(m.startLine, m.matchedLines, "indentation"),
          };
        }

        if (normalizedMatches.length > 1) {
          return {
            block: true,
            reason: formatMultipleMatches(normalizedMatches.length, 1.0),
          };
        }
      }
    }

    // 1 ocurrencia literal (único, el nativo funciona perfecto)
    // 0 ocurrencias sin match normalized (deja pasar al nativo, tool_result se encarga)
  });

  // Layer 2: catch native edit failures and offer the most probable target
  pi.on("tool_result", async (event) => {
    if (event.toolName !== GUARDED_TOOL) return;
    if (!event.isError) return;

    const input = event.input as {
      path?: string;
      edits?: Array<{ oldText?: string; newText?: string }>;
    } | undefined;
    const filePath = input?.path;
    const oldText = input?.edits?.[0]?.oldText;

    if (!filePath || !oldText) return;

    let fileContent: string;
    try {
      fileContent = await readFile(filePath, "utf-8");
    } catch {
      return;
    }

    if (fileContent.length > MAX_FILE_SIZE) return;

    const normalizedFileContent = fileContent.replace(/\r\n/g, "\n");
    const normalizedOldText = normalizeText(oldText.replace(/\r\n/g, "\n"));

    if (normalizedOldText.length === 0) return;

    const threshold = getThreshold();

    // ── Level A: whitespace-normalized exact match ──
    const normalizedMatches = findNormalizedMatches(
      normalizedFileContent,
      normalizedOldText,
    );

    if (normalizedMatches.length === 1) {
      const m = normalizedMatches[0];
      mutateToolResult(event, formatCandidate(m.startLine, m.matchedLines, "indentation"), false);
      return undefined;
    }

    if (normalizedMatches.length > 1) {
      mutateToolResult(event, formatMultipleMatches(normalizedMatches.length, 1.0), false);
      return undefined;
    }

    // ── Level B: fuzzy diff-based ──
    const fuzzyMatches = findFuzzyMatches(
      normalizedFileContent,
      oldText,
      threshold,
    );

    if (fuzzyMatches.length === 1) {
      const m = fuzzyMatches[0];
      mutateToolResult(event, formatCandidate(m.startLine, m.matchedLines, "fuzzy"), false);
      return undefined;
    }

    if (fuzzyMatches.length > 1) {
      mutateToolResult(event, formatMultipleMatches(fuzzyMatches.length, threshold), false);
      return undefined;
    }

    // ── Nothing above threshold: find best match for hint ──
    const allCandidates = findFuzzyMatches(normalizedFileContent, oldText, 0).sort(
      (a, b) => b.similarity - a.similarity,
    );
    const bestSimilarity = allCandidates[0]?.similarity ?? 0;
    mutateToolResult(event, formatNoMatch(bestSimilarity, threshold), false);
    return undefined;
  });
}