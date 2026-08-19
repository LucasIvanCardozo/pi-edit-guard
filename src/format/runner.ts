/**
 * Formatter runner: invokes an external formatter subprocess via `pi.exec`
 * and reports whether the file content changed.
 *
 * Uses the Pi ExtensionAPI's `exec` method (not `child_process.spawn`)
 * because Pi handles sandboxing, permissions, timeout, and abort signals in a
 * consistent way. The caller doesn't need to wire up any of that.
 *
 * Contract: never throws. All failure modes (binary missing, non-zero exit,
 * timeout, exception) are reported through `FormatterRunResult`. The caller
 * decides whether to surface anything to the model.
 */

import { readFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ResolvedFormatter } from "../formatter-config.ts";

export interface FormatterRunResult {
  /** True when the formatter ran successfully AND changed the file content. */
  changed: boolean;
  /** Full content after the formatter ran (whether it changed or not). */
  content: string;
  /** Truncated stderr on failure; empty string on success. */
  stderr: string;
  /** Exit code on non-zero exit; undefined on success. */
  exitCode?: number;
  /** Resolved command (for debug logging). */
  command: string;
  /** Wall-clock duration in ms (best-effort). */
  durationMs: number;
}

const FORMATTER_TIMEOUT_MS = 5_000;
const STDERR_TRUNCATE = 500;

/**
 * Run a formatter against a file. Reads the file before, invokes the
 * formatter with `--` separator + absolute path, reads the file after, and
 * reports whether content changed.
 *
 * Never throws. On any failure mode, returns a result with `changed: false`
 * and a populated `stderr` so the caller can decide what to do.
 */
export async function runFormatter(
  filePath: string,
  formatter: ResolvedFormatter,
  pi: ExtensionAPI,
): Promise<FormatterRunResult> {
  const command = formatter.command.join(" ");
  const start = Date.now();

  let before: string;
  try {
    before = await readFile(filePath, "utf-8");
  } catch (err) {
    return {
      changed: false,
      content: "",
      stderr: `pi-edit-guard: cannot read file before formatter: ${(err as Error).message}`,
      command,
      durationMs: Date.now() - start,
    };
  }

  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await pi.exec(
      formatter.command[0],
      [...formatter.command.slice(1), "--", filePath],
      { timeout: FORMATTER_TIMEOUT_MS },
    );
  } catch (err) {
    // pi.exec should never throw, but defend against older Pi versions
    return {
      changed: false,
      content: before,
      stderr: `pi-edit-guard: formatter exec failed: ${(err as Error).message}`,
      command,
      durationMs: Date.now() - start,
    };
  }

  const durationMs = Date.now() - start;

  if (result.code !== 0) {
    return {
      changed: false,
      content: before,
      stderr: (result.stderr || "").slice(0, STDERR_TRUNCATE),
      exitCode: result.code,
      command,
      durationMs,
    };
  }

  let after: string;
  try {
    after = await readFile(filePath, "utf-8");
  } catch (err) {
    return {
      changed: false,
      content: before,
      stderr: `pi-edit-guard: cannot read file after formatter: ${(err as Error).message}`,
      command,
      durationMs,
    };
  }

  return {
    changed: before !== after,
    content: after,
    stderr: "",
    command,
    durationMs,
  };
}