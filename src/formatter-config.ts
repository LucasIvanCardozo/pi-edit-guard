/**
 * Auto-format configuration: load, merge, resolve, and match formatters.
 *
 * Adapted from pi-code-formatter
 * (https://github.com/losnappas/pi-code-formatter) by losnappas. MIT License.
 *
 * The configuration schema is a verbatim port: `commands` (name → argv array)
 * and `filetypes` (glob/regex/literal pattern → command name). The match
 * resolution (specific patterns first, wildcard `*` last) and the pattern
 * compilation rules are also ported. The merge order (global first, project
 * overrides) and the config paths match pi-code-formatter.
 *
 * What changed from the original:
 *   - The `compilePattern`/`resolveFormatters`/`findFormatter` flow is split
 *     into pure helpers that take an explicit `ResolvedFormatter[]` array
 *     instead of reading a module-level variable. Pure functions are easier
 *     to unit-test and let `extension.ts` own the state.
 *   - `findFormatter` takes the resolved formatters as a parameter (no
 *     hidden global state).
 *   - Paths use `pi-edit-guard` instead of `pi-code-formatter`.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The raw config schema, identical to pi-code-formatter's.
 *
 *   commands:  { "prettier": ["npx", "prettier", "--write"], ... }
 *   filetypes: { "*.ts": "prettier", "*.md": "prettier", "*": "prettier" }
 *
 * A pattern maps to a command name; the command name maps to an argv array.
 */
export interface AutoformatConfig {
  commands: Record<string, string[]>;
  filetypes: Record<string, string>;
}

/**
 * A formatter ready to be invoked against a file. `pattern` is optional:
 * when absent, the entry is a wildcard fallback (matches any file that no
 * more-specific pattern picked up).
 */
export interface ResolvedFormatter {
  name: string;
  command: string[];
  /** Optional regex pattern. Absence means wildcard fallback ("*"). */
  pattern?: RegExp;
}

// ── Paths ─────────────────────────────────────────────────────────────────

function getGlobalConfigPath(): string {
  return resolve(homedir(), ".pi", "agent", "extensions", "pi-edit-guard", "config.json");
}

function getProjectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "extensions", "pi-edit-guard", "config.json");
}

// ── Loading ───────────────────────────────────────────────────────────────

async function loadJson(path: string): Promise<AutoformatConfig | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as AutoformatConfig;
  } catch {
    return null;
  }
}

/**
 * Merge two configs. Project overrides global for matching keys. Both
 * `commands` and `filetypes` are merged shallowly (per-key last-wins).
 */
export function mergeConfigs(
  globalCfg: AutoformatConfig | null,
  projectCfg: AutoformatConfig | null,
): AutoformatConfig | null {
  if (!globalCfg && !projectCfg) return null;

  const commands: Record<string, string[]> = {
    ...(globalCfg?.commands ?? {}),
    ...(projectCfg?.commands ?? {}),
  };
  const filetypes: Record<string, string> = {
    ...(globalCfg?.filetypes ?? {}),
    ...(projectCfg?.filetypes ?? {}),
  };
  return { commands, filetypes };
}

/**
 * Load both config files (global + project) and merge. Returns null when
 * neither exists — the caller should treat that as "no formatter configured"
 * and skip the formatter path entirely.
 */
export async function loadConfig(cwd: string): Promise<AutoformatConfig | null> {
  const globalPath = getGlobalConfigPath();
  const projectPath = getProjectConfigPath(cwd);

  const [globalCfg, projectCfg] = await Promise.all([
    loadJson(globalPath),
    loadJson(projectPath),
  ]);

  return mergeConfigs(globalCfg, projectCfg);
}

// ── Pattern compilation ──────────────────────────────────────────────────

/**
 * Compile a config pattern string into a regex.
 *
 * Rules (verbatim from pi-code-formatter):
 *   - `"*.ext"` → `/\.ext$/`
 *   - `"/regex/"` → `new RegExp(<middle>)`
 *   - `"literal"` → `/literal$/` (suffix match)
 *   - `"*"` is handled by the caller — it's the wildcard marker, not a regex.
 */
export function compilePattern(pattern: string): RegExp {
  // Simple "*.ext" glob → regex matching the extension at end of path
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".ext"
    return new RegExp(`\\${ext}$`);
  }
  // Explicit regex syntax "/pattern/flags"
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    return new RegExp(pattern.slice(1, -1));
  }
  // Otherwise treat as literal suffix match
  return new RegExp(`${pattern}$`);
}

// ── Resolution + matching ─────────────────────────────────────────────────

/**
 * Resolve a raw config into an ordered list of formatters ready to match
 * against file paths.
 *
 * Order matters: `findFormatter` walks the list and picks the first match,
 * so more-specific patterns (`*.ts`) are placed BEFORE the wildcard (`*`)
 * fallback. Wildcards get no `pattern` field.
 *
 * Unknown command names (referenced from `filetypes` but not present in
 * `commands`) are skipped with a console warning. We don't throw — partial
 * configs are still useful.
 */
export function resolveFormatters(config: AutoformatConfig): ResolvedFormatter[] {
  const result: ResolvedFormatter[] = [];

  for (const [pattern, cmdName] of Object.entries(config.filetypes)) {
    const command = config.commands[cmdName];
    if (!command) {
      console.warn(
        `[pi-edit-guard] Unknown command "${cmdName}" referenced for pattern "${pattern}"`,
      );
      continue;
    }

    if (pattern === "*") {
      // Wildcard: add to end as fallback (no pattern field)
      result.push({ name: cmdName, command });
    } else {
      // Specific: add to FRONT so it's tried first by findFormatter
      const regex = compilePattern(pattern);
      result.unshift({ name: cmdName, command, pattern: regex });
    }
  }

  return result;
}

/**
 * Find the first matching formatter for a file path.
 *
 *   1. Pattern-based formatters (most-specific first because resolveFormatters
 *      placed them at the front of the array).
 *   2. Wildcard fallback (no `pattern` field).
 *
 * Returns null when nothing matches — caller should treat as "no formatter
 * for this file".
 */
export function findFormatter(
  formatters: ResolvedFormatter[],
  filePath: string,
): ResolvedFormatter | null {
  // First pass: pattern-based (specific wins)
  for (const f of formatters) {
    if (f.pattern && f.pattern.test(filePath)) return f;
  }
  // Second pass: wildcard fallback
  for (const f of formatters) {
    if (!f.pattern) return f;
  }
  return null;
}