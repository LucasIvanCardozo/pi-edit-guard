/**
 * Tests for the formatter config module.
 *
 * Pure functions: compilePattern, resolveFormatters, findFormatter,
 * mergeConfigs. No I/O at this layer (loadConfig is tested separately
 * against fixture files).
 */

import {
  assert,
  assertEq,
  section,
} from './_framework.ts';

import {
  compilePattern,
  type AutoformatConfig,
  findFormatter,
  mergeConfigs,
  resolveFormatters,
} from '../src/formatter-config.ts';

export function run(): void {
  section('formatter-config: compilePattern rules');

  {
    const re = compilePattern('*.ts');
    assert(re.test('foo.ts'), '*.ts matches foo.ts');
    assert(re.test('a/b/c.ts'), '*.ts matches a/b/c.ts');
    assert(!re.test('foo.js'), '*.ts does not match foo.js');
  }

  {
    const re = compilePattern('*.md');
    assert(re.test('README.md'), '*.md matches README.md');
    assert(!re.test('foo.ts'), '*.md does not match foo.ts');
  }

  {
    const re = compilePattern('/\\.py$/');
    assert(re.test('foo.py'), 'regex /\\.py$/ matches foo.py');
    assert(!re.test('foo.ts'), 'regex does not match foo.ts');
  }

  {
    const re = compilePattern('literal-suffix');
    assert(re.test('foo-literal-suffix'), 'literal-suffix matches foo-literal-suffix');
    assert(re.test('literal-suffix'), 'literal-suffix matches literal-suffix exactly');
    assert(!re.test('foo-literal'), 'literal-suffix does not match partial prefix');
  }

  section('formatter-config: resolveFormatters ordering');

  {
    const config: AutoformatConfig = {
      commands: {
        prettier: ['prettier', '--write'],
        eslint: ['eslint', '--fix'],
      },
      filetypes: {
        '*': 'prettier',
        '*.ts': 'prettier',
        '*.md': 'prettier',
      },
    };
    const resolved = resolveFormatters(config);
    // Specific patterns unshifted to front; wildcard stays at end
    assertEq(resolved.length, 3, 'resolves 3 formatters');
    assert(resolved[0].pattern !== undefined, 'first has a pattern (specific)');
    assert(resolved[2].pattern === undefined, 'last has no pattern (wildcard)');
  }

  {
    const config: AutoformatConfig = {
      commands: {
        prettier: ['prettier', '--write'],
        eslint: ['eslint', '--fix'],
      },
      filetypes: {
        '*.ts': 'eslint',
        '*.md': 'prettier',
      },
    };
    const resolved = resolveFormatters(config);
    assertEq(resolved.length, 2, 'resolves 2 formatters (no wildcard)');
    assert(
      resolved.every((f) => f.pattern !== undefined),
      'every entry has a pattern when no wildcard present',
    );
  }

  {
    // Stderr capture for the "unknown command" warning
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const config: AutoformatConfig = {
        commands: { prettier: ['prettier'] },
        filetypes: { '*.ts': 'unknown-tool' },
      };
      const resolved = resolveFormatters(config);
      assertEq(resolved.length, 0, 'skips unknown command references');
      assert(
        warnings.some((w) => w.includes('unknown-tool')),
        'logs warning about unknown command',
      );
    } finally {
      console.warn = origWarn;
    }
  }

  section('formatter-config: findFormatter priority');

  {
    const formatters = resolveFormatters({
      commands: {
        prettier: ['prettier'],
        eslint: ['eslint'],
      },
      filetypes: {
        '*': 'prettier',
        '*.ts': 'eslint',
      },
    });
    const match = findFormatter(formatters, 'foo.ts');
    assert(match !== null, 'finds formatter for foo.ts');
    assertEq(match?.name, 'eslint', 'specific pattern beats wildcard');
  }

  {
    const formatters = resolveFormatters({
      commands: { prettier: ['prettier'] },
      filetypes: { '*': 'prettier' },
    });
    const match = findFormatter(formatters, 'foo.unknown-ext');
    assert(match !== null, 'wildcard matches unknown extension');
    assertEq(match?.name, 'prettier', 'wildcard formatter is returned');
  }

  {
    const formatters = resolveFormatters({
      commands: { prettier: ['prettier'] },
      filetypes: { '*.ts': 'prettier' },
    });
    const match = findFormatter(formatters, 'foo.js');
    assertEq(match, null, 'no match when pattern does not match and no wildcard');
  }

  section('formatter-config: mergeConfigs (project overrides global)');

  {
    const globalCfg: AutoformatConfig = {
      commands: { prettier: ['prettier'], eslint: ['eslint'] },
      filetypes: { '*.ts': 'prettier' },
    };
    const projectCfg: AutoformatConfig = {
      commands: { prettier: ['pnpm', 'prettier'] },
      filetypes: { '*.ts': 'eslint' },
    };
    const merged = mergeConfigs(globalCfg, projectCfg);
    assert(merged !== null, 'merge returns non-null');
    assertEq(
      merged?.commands.prettier.join(' '),
      'pnpm prettier',
      'project command overrides global',
    );
    assertEq(
      merged?.commands.eslint.join(' '),
      'eslint',
      'global command preserved when not overridden',
    );
    assertEq(merged?.filetypes['*.ts'], 'eslint', 'project filetype overrides global');
  }

  {
    assertEq(mergeConfigs(null, null), null, 'both null → null');
    const projectCfg: AutoformatConfig = {
      commands: { prettier: ['prettier'] },
      filetypes: { '*.ts': 'prettier' },
    };
    const merged = mergeConfigs(null, projectCfg);
    assert(merged !== null, 'project-only returns the project config');
    assertEq(merged?.commands.prettier.join(' '), 'prettier', 'project command preserved');
  }

  {
    const globalCfg: AutoformatConfig = {
      commands: { prettier: ['prettier'] },
      filetypes: { '*.ts': 'prettier' },
    };
    const merged = mergeConfigs(globalCfg, null);
    assert(merged !== null, 'global-only returns the global config');
    assertEq(merged?.commands.prettier.join(' '), 'prettier', 'global command preserved');
  }
}