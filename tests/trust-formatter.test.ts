/**
 * Tests for trust-formatter mode (`PI_EDIT_GUARD_TRUST_FORMATTER=1`).
 *
 * In trust mode the guard skips autofix entirely and passes newText verbatim
 * to native edit. Designed for projects that run an external formatter
 * (pi-autoformat, biome, prettier) alongside. The cascade still validates
 * that there's a match — ambiguous/fuzzy/no-match still block.
 *
 * What we test here:
 * - `shouldTrustFormatter()` reads the env var correctly (default off, opt-in).
 * - The flag is registered with `pi.registerFlag()` for discoverability.
 * - Regression: the default mode behavior (autofix mutates edits) is still
 *   covered by `tests/extension.test.ts` and continues to pass.
 *
 * Why we don't test the cascade behavior in trust mode via the full extension
 * lifecycle: `shouldTrustFormatter()` is called once at module load, not
 * per invocation, so we can't toggle the mode between tests without
 * re-importing the module (and jiti caches). The cascade logic itself is
 * covered by the cascade + autofix unit tests (`tests/evaluate.test.ts` +
 * `tests/autofix.test.ts`); the wiring in `extension.ts` is verified by
 * `tests/extension.test.ts`. This file focuses on the contract surface:
 * the env var, the flag registration, and the opt-in semantics.
 */

import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';

import { assert, assertEq, assertMatch, section } from './_framework.ts';

const jiti = createJiti(fileURLToPath(import.meta.url), {
  interopDefault: true,
  esmResolve: true,
});

const ORIGINAL_TRUST = process.env.PI_EDIT_GUARD_TRUST_FORMATTER;

async function withTrust<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  return (async () => {
    if (value === undefined) delete process.env.PI_EDIT_GUARD_TRUST_FORMATTER;
    else process.env.PI_EDIT_GUARD_TRUST_FORMATTER = value;
    try {
      return await fn();
    } finally {
      if (ORIGINAL_TRUST === undefined) delete process.env.PI_EDIT_GUARD_TRUST_FORMATTER;
      else process.env.PI_EDIT_GUARD_TRUST_FORMATTER = ORIGINAL_TRUST;
    }
  })();
}

export async function run(): Promise<void> {
  section('trust-formatter: shouldTrustFormatter env var matrix');
  {
    const { shouldTrustFormatter } = await import('../src/config.ts');
    await withTrust(undefined, async () => {
      assertEq(shouldTrustFormatter(), false, 'env unset → default OFF (opt-in)');
    });
    await withTrust('0', async () => {
      assertEq(shouldTrustFormatter(), false, 'env=0 → OFF');
    });
    await withTrust('false', async () => {
      assertEq(shouldTrustFormatter(), false, 'env=false → OFF');
    });
    await withTrust('no', async () => {
      assertEq(shouldTrustFormatter(), false, 'env=no → OFF');
    });
    await withTrust('1', async () => {
      assertEq(shouldTrustFormatter(), true, 'env=1 → ON');
    });
    await withTrust('true', async () => {
      assertEq(shouldTrustFormatter(), true, 'env=true → ON');
    });
    await withTrust('yes', async () => {
      assertEq(shouldTrustFormatter(), true, 'env=yes → ON');
    });
  }

  section('trust-formatter: flag is registered with pi.registerFlag');
  {
    // Load with trust OFF to test the registration happens regardless of mode.
    await withTrust(undefined, async () => {
      const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
      const registeredFlags: Array<{ name: string; options: unknown }> = [];
      const pi = {
        on(_event: string, _handler: unknown): void {
          // no-op: we only care about flag registration here
        },
        registerTool(_tool: unknown): void {
          // no-op
        },
        registerFlag(name: string, options: unknown): void {
          registeredFlags.push({ name, options });
        },
      };
      mod.default(pi);
      const trustFlag = registeredFlags.find((f) => f.name === 'trust-formatter');
      assert(trustFlag !== undefined, 'trust-formatter flag is registered');
      assertEq((trustFlag!.options as any).type, 'boolean', 'flag type is boolean');
      assertEq((trustFlag!.options as any).default, false, 'flag defaults to false (opt-in)');
      assertMatch(
        (trustFlag!.options as any).description as string,
        /skip.*autofix|external formatter/i,
        'description explains the contract',
      );
    });
  }

  section('trust-formatter: flag is also registered when trust mode is ON');
  {
    // Sanity check: registration happens in the export default function,
    // before shouldTrustFormatter() is read. So mode doesn't affect registration.
    await withTrust('1', async () => {
      const mod = jiti(join(import.meta.dirname, '..', 'index.ts'));
      const registeredFlags: Array<{ name: string; options: unknown }> = [];
      const pi = {
        on(_event: string, _handler: unknown): void {},
        registerTool(_tool: unknown): void {},
        registerFlag(name: string, options: unknown): void {
          registeredFlags.push({ name, options });
        },
      };
      mod.default(pi);
      assert(
        registeredFlags.some((f) => f.name === 'trust-formatter'),
        'trust-formatter flag is registered even when trust mode is ON',
      );
    });
  }
}

// Re-add the helper import for the runtime path used in section above.
import { join } from 'node:path';
