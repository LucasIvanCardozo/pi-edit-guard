/**
 * Configuration: env var readers and constants.
 *
 * All values are read at call time (not at module load), so changes to
 * `process.env` between hook invocations are reflected.
 */

export const GUARDED_TOOL = 'edit';
export const DEFAULT_THRESHOLD = 0.9;
export const DEFAULT_MAX_EXAMPLES = 3;
export const DEFAULT_HINT_MIN = 0.5;
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

function getIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    console.warn(`[pi-edit-guard] invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function getFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.warn(`[pi-edit-guard] invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

export function getThreshold(): number {
  return getFloatEnv('PI_EDIT_GUARD_THRESHOLD', DEFAULT_THRESHOLD);
}

export function getMaxExamples(): number {
  return getIntEnv('PI_EDIT_GUARD_EXAMPLES', DEFAULT_MAX_EXAMPLES);
}

export function getHintMinSimilarity(): number {
  return getFloatEnv('PI_EDIT_GUARD_HINT_MIN', DEFAULT_HINT_MIN);
}
