    /**
     * E2E test: verify the cascade empty-line rule fix from v0.12.2.
     *
     * Two scenarios:
     * A. Default mode + uniform drift + blank line in middle of needle
     *    → cascade finds unique-drift, autofix succeeds (proves empty-line fix)
     *
     * B. Trust mode (formatter configured) + non-uniform drift + blank line
     *    → cascade finds unique-drift, autofix succeeds (oldText-only)
     *    (This mirrors the exact bug the user hit in StaffOrderDetailModal.)
     */
    import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { createJiti } from 'jiti';

    const jiti = createJiti(fileURLToPath(import.meta.url), {
      interopDefault: true,
      esmResolve: true,
    });
    const mod = jiti(join('/home/lucas/.pi/agent/npm/node_modules/@lucascardozo/pi-edit-guard', 'index.ts'));
    const extension = mod.default;

    let totalPassed = 0;
    let totalFailed = 0;

    function assert(cond: boolean, label: string) {
      if (cond) { console.log(`  ✓ ${label}`); totalPassed++; }
      else { console.log(`  ✗ ${label}`); totalFailed++; }
    }

    function makePiMock(dir: string) {
      const sessionHandlers: Array<(e: unknown, ctx: unknown) => unknown> = [];
      const toolCallHandlers: Array<(e: unknown, ctx: unknown) => unknown> = [];
      const pi = {
        on(event: string, handler: (e: unknown, ctx?: unknown) => unknown) {
          if (event === 'session_start') sessionHandlers.push(handler);
          if (event === 'tool_call') toolCallHandlers.push(handler);
        },
        registerTool(_t: unknown): void {},
        registerFlag(_f: unknown): void {},
        ui: { notify: () => {} },
        cwd: dir,
        exec: async (_cmd: string, _args: string[], _opts: unknown) => ({
          code: 0, stdout: '', stderr: '',
        }),
      };
      extension(pi);
      return { sessionHandlers, toolCallHandlers, pi };
    }

    // ───────────────────────────────────────────────────────────────────
    // Scenario A: default mode, uniform drift, blank line in middle
    // ───────────────────────────────────────────────────────────────────
    console.log('━━━ Scenario A: default mode + uniform drift + blank line in middle ━━━');
    {
      const dir = mkdtempSync(join(tmpdir(), 'peg-empty-line-A-'));
      const testFile = join(dir, 'Component.tsx');
      writeFileSync(
        testFile,
        [
          "'use client';",
          "",
          "export const Component = ({ foo }: { foo: string }) => {",
          "  const a = 1;",
          "  const b = 2;",
          "  const c = 3;",
          "  const d = 4;",
          "",
          "  const e = 5;",
          "",
          "  return foo;",
          "};",
          "",
        ].join('\n'),
      );

      const { sessionHandlers: _sh, toolCallHandlers } = makePiMock(dir);
      // Uniform drift: all non-blank lines at 0sp, file at 2sp → delta = +2 uniform
      const event = {
        toolName: 'edit',
        input: {
          path: testFile,
          edits: [
            {
              oldText: [
                'const a = 1;',                  // 0sp
                'const b = 2;',                  // 0sp
                'const c = 3;',                  // 0sp
                'const d = 4;',                  // 0sp
                '',                              // BLANK in middle
                'const e = 5;',                  // 0sp
              ].join('\n'),
              newText: [
                'const a = 1;',
                'const b = 2;',
                'const c = 3;',
                'const d = 4;',
                '',
                'const e = 5;',
                '',
                '// new comment',
                'const f = 6;',
              ].join('\n'),
            },
          ],
        },
      };
      const ctx = { cwd: dir, ui: { notify: () => {} } };
      const result = await toolCallHandlers[0](event, ctx);
      const edits = (event.input as { edits: Array<{ oldText: string; newText: string }> }).edits;

      assert(result === undefined, 'returns undefined (autofix succeeded)');
      assert(
        edits[0].oldText === '  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n\n  const e = 5;',
        'oldText mutated to file block (all 2sp, blank preserved)',
      );
      assert(
        edits[0].newText === '  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n\n  const e = 5;\n\n  // new comment\n  const f = 6;',
        'newText shifted by +2 (uniform delta applied to all non-blank lines)',
      );

      rmSync(dir, { recursive: true });
    }

    // ───────────────────────────────────────────────────────────────────
    // Scenario B: trust mode (formatter configured) + non-uniform drift + blank line
    // (This is the EXACT bug the user hit in StaffOrderDetailModal.tsx)
    // ───────────────────────────────────────────────────────────────────
    console.log('');
    console.log('━━━ Scenario B: trust mode (formatter) + non-uniform drift + blank line ━━━');
    {
      const dir = mkdtempSync(join(tmpdir(), 'peg-empty-line-B-'));
      const piDir = join(dir, '.pi', 'extensions', 'pi-edit-guard');
      mkdirSync(piDir, { recursive: true });
      writeFileSync(
        join(piDir, 'config.json'),
        JSON.stringify({
          commands: { fakefmt: ['true'] },
          filetypes: { '*.tsx': 'fakefmt' },
        }),
      );
      const testFile = join(dir, 'Component.tsx');
      writeFileSync(
        testFile,
        [
          "'use client';",
          "",
          "export const StaffOrderDetailModal = ({ serviceRequest }: Props) => {",
          "  const { closeModal } = useModal();",
          "",
          "  const { order, employee } = serviceRequest;",
          "  const orderStatus = order?.status ?? 'pending';",
          "  const isCashierContext = pageContext === 'cashier';",
          "  const total = calculateOrderTotal(order);",
          "",
          "  const statusHistory = order?.statusHistory ?? [];",
          "",
          "  return <div>{statusHistory.length}</div>;",
          "};",
          "",
        ].join('\n'),
      );

      const { sessionHandlers, toolCallHandlers } = makePiMock(dir);
      await sessionHandlers[0]({}, { cwd: dir, ui: { notify: () => {} } });

      // Exact pattern from the user's bug report: 4 consts (1 at 0sp + 3 at 2sp drift)
      // + blank + 1 const at 2sp drift. In v0.12.0 this was fuzzy-match → blocked.
      // In v0.12.2 (with the fix) it should be unique-drift → autofix succeeds in trust mode.
      const event = {
        toolName: 'edit',
        input: {
          path: testFile,
          edits: [
            {
              oldText: [
                'const { order, employee } = serviceRequest;',                  // 0sp
                '  const orderStatus = order?.status ?? \'pending\';',          // 2sp drift
                '  const isCashierContext = pageContext === \'cashier\';',      // 2sp drift
                '  const total = calculateOrderTotal(order);',                  // 2sp drift
                '',                                                              // BLANK in middle
                '  const statusHistory = order?.statusHistory ?? [];',           // 2sp drift
              ].join('\n'),
              newText: [
                'const { order, employee } = serviceRequest;',
                '  const orderStatus = order?.status ?? \'pending\';',
                '  const isCashierContext = pageContext === \'cashier\';',
                '  const total = calculateOrderTotal(order);',
                '',
                '  const statusHistory = order?.statusHistory ?? [];',
                '',
                '  const printState = useOrderPrintState(order?.id, order?.venueId);',
                '  const kitchenPrintedAt = order?.kitchenPrintedAt ?? null;',
              ].join('\n'),
            },
          ],
        },
      };
      const ctx = { cwd: dir, ui: { notify: () => {} } };
      const result = await toolCallHandlers[0](event, ctx);
      const edits = (event.input as { edits: Array<{ oldText: string; newText: string }> }).edits;

      assert(result === undefined, 'returns undefined (autofix succeeded in trust mode despite non-uniform drift)');
      assert(
        edits[0].oldText === '  const { order, employee } = serviceRequest;\n  const orderStatus = order?.status ?? \'pending\';\n  const isCashierContext = pageContext === \'cashier\';\n  const total = calculateOrderTotal(order);\n\n  const statusHistory = order?.statusHistory ?? [];',
        'oldText mutated to file block (all 2sp, blank preserved)',
      );
      assert(
        edits[0].newText === 'const { order, employee } = serviceRequest;\n  const orderStatus = order?.status ?? \'pending\';\n  const isCashierContext = pageContext === \'cashier\';\n  const total = calculateOrderTotal(order);\n\n  const statusHistory = order?.statusHistory ?? [];\n\n  const printState = useOrderPrintState(order?.id, order?.venueId);\n  const kitchenPrintedAt = order?.kitchenPrintedAt ?? null;',
        'newText verbatim (trust mode: shiftNewText=false; formatter will normalize post-edit)',
      );

      rmSync(dir, { recursive: true });
    }

    console.log('');
    console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
    if (totalFailed > 0) process.exit(1);

