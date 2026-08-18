/**
 * Tests for the read tool override (`src/read-override.ts`).
 *
 * The override fixes the TUI padding problem: the built-in read tool renders
 * file content inside Box(paddingX=1) + Text(paddingX=1), which adds ~4
 * spaces of leading whitespace per line that the model mistakes for actual
 * file content. The override uses the built-in `execute` (so images, syntax
 * truncation, image hints all work) but renders compactly by default.
 *
 * These tests verify:
 * - registerRawReadTool calls pi.registerTool with name "read"
 * - renderCall returns a minimal "read <path>" header
 * - renderResult returns empty (compact) by default
 * - renderResult delegates to built-in when expanded or error
 * - The override does not lose any of the execute functionality
 *
 * Note: we avoid `section()` blocks here because Node's TS stripper has
 * trouble parsing some assertion patterns inside deeply-nested block scopes.
 * Plain `assert(...)` calls give clearer pass/fail signals without that risk.
 */

import { assert, assertEq, assertMatch } from './_framework.ts';
import { registerRawReadTool } from '../src/read-override.ts';

interface CapturedTool {
	name: string;
	description?: string;
	execute?: (...args: unknown[]) => unknown;
	renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
}

interface MockPi {
	pi: { registerTool: (tool: CapturedTool) => void };
	captured: CapturedTool[];
}

function createMockPi(): MockPi {
	const captured: CapturedTool[] = [];
	const pi = {
		registerTool(tool: CapturedTool): void {
			captured.push(tool);
		},
	};
	return { pi, captured };
}

function makeLastComponent(): { setText: (text: string) => void; text: string } {
	const obj: { setText: (text: string) => void; text: string } = {
		text: '<initial>',
		setText(newText: string): void {
			obj.text = newText;
		},
	};
	return obj;
}

function getChain(value: unknown, ...keys: string[]): unknown {
	let current: unknown = value;
	for (const key of keys) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

export function run(): void {
	// 1. registers the read tool
	const m1 = createMockPi();
	registerRawReadTool(m1.pi as any, '/tmp');
	assertEq(m1.captured.length, 1, 'registers exactly one tool');
	assertEq(m1.captured[0].name, 'read', 'tool name is "read" (overrides built-in)');
	assert(m1.captured[0].execute !== undefined, 'execute is wired from built-in');

	// 2. renderCall returns minimal "read <path>"
	const m2 = createMockPi();
	registerRawReadTool(m2.pi as any, '/tmp');
	const tool2 = m2.captured[0];
	const lastComponent2 = makeLastComponent();
	const callResult2 = tool2.renderCall({ path: '/tmp/foo.ts' }, {}, { lastComponent: lastComponent2 });
	const callText2 = getChain(callResult2, 'text');
	assertEq(callText2, 'read /tmp/foo.ts', 'renderCall sets text to "read <path>"');

	// 3. renderCall falls back to file_path
	const m3 = createMockPi();
	registerRawReadTool(m3.pi as any, '/tmp');
	const tool3 = m3.captured[0];
	const lastComponent3 = makeLastComponent();
	const callResult3 = tool3.renderCall({ file_path: '/tmp/bar.ts' }, {}, { lastComponent: lastComponent3 });
	const callText3 = getChain(callResult3, 'text');
	assertEq(callText3, 'read /tmp/bar.ts', 'uses file_path when path is absent');

	// 4. renderResult returns empty in compact mode
	const m4 = createMockPi();
	registerRawReadTool(m4.pi as any, '/tmp');
	const tool4 = m4.captured[0];
	const lastComponent4 = makeLastComponent();
	const result4 = tool4.renderResult(
		{ content: [{ type: 'text', text: 'file body' }] },
		{ expanded: false },
		{},
		{ lastComponent: lastComponent4, isError: false },
	);
	const rendered4 = (result4 as { render?: (w: number) => string[] }).render?.(80) ?? [];
	assertEq(rendered4.length, 0, 'compact mode renders 0 lines (no TUI padding)');

	// 5. renderResult delegates when expanded
	const m5 = createMockPi();
	registerRawReadTool(m5.pi as any, '/tmp');
	const tool5 = m5.captured[0];
	const lastComponent5 = makeLastComponent();
	const result5 = tool5.renderResult(
		{ content: [{ type: 'text', text: 'body' }] },
		{ expanded: true },
		{},
		{ lastComponent: lastComponent5, isError: false },
	);
	const resultText5 = getChain(result5, 'text');
	assert(resultText5 !== '', 'expanded mode delegates to built-in (text is not empty)');

	// 6. renderResult delegates on error
	const m6 = createMockPi();
	registerRawReadTool(m6.pi as any, '/tmp');
	const tool6 = m6.captured[0];
	const lastComponent6 = makeLastComponent();
	const result6 = tool6.renderResult(
		{ content: [{ type: 'text', text: 'ENOENT' }] },
		{ expanded: false },
		{},
		{ lastComponent: lastComponent6, isError: true },
	);
	const resultText6 = getChain(result6, 'text');
	assert(resultText6 !== '', 'error mode delegates to built-in (text is not empty)');

	// 7. renderCall and renderResult are defined
	const m7 = createMockPi();
	registerRawReadTool(m7.pi as any, '/tmp');
	const tool7 = m7.captured[0];
	assert(tool7.renderCall !== undefined, 'renderCall is defined');
	assert(tool7.renderResult !== undefined, 'renderResult is defined');

	// 8. regression: no leading 4-space padding in renderCall output
	const m8 = createMockPi();
	registerRawReadTool(m8.pi as any, '/tmp');
	const tool8 = m8.captured[0];
	const lastComponent8 = makeLastComponent();
	const callResult8 = tool8.renderCall({ path: '/tmp/test.ts' }, {}, { lastComponent: lastComponent8 });
	const callText8 = String(getChain(callResult8, 'text'));
	assertMatch(callText8, /^read /, 'renderCall output starts with "read "');
	const leadingSpaces8 = callText8.match(/^ +/);
	assert(leadingSpaces8 === null, 'renderCall output has no leading spaces');

	// 9. regression: renderResult compact output has no padding
	const m9 = createMockPi();
	registerRawReadTool(m9.pi as any, '/tmp');
	const tool9 = m9.captured[0];
	const lastComponent9 = makeLastComponent();
	const result9 = tool9.renderResult(
		{ content: [{ type: 'text', text: 'x' }] },
		{ expanded: false },
		{},
		{ lastComponent: lastComponent9, isError: false },
	);
	const rendered9 = (result9 as { render?: (w: number) => string[] }).render?.(80) ?? [];
	assertEq(rendered9.length, 0, 'renderResult compact output renders 0 lines');
}