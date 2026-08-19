/**
 * Override of the built-in `read` tool.
 *
 * Why this exists:
 * The built-in read tool renders the file content inside a Box(paddingX=1)
 * and Text(paddingX=1) in the TUI. Together with the chat message container
 * (also padded), the model sees the file content with ~4 extra spaces of
 * leading whitespace per line — even when the file itself has 0 spaces.
 *
 * The model can't tell those 4 spaces apart from the file's actual whitespace.
 * When it copies them into an `edit` call's `oldText`, the edit fails with
 * "Could not find the exact text" because the file doesn't have those 4 spaces.
 * This causes the surrender pattern: after 2-3 failed retries, the model
 * gives up and switches to bash/python to write the file.
 *
 * The fix:
 * Override `renderCall` and `renderResult`, and use `renderShell: "self"` so
 * the runtime skips the Box(paddingX=1) wrapper entirely. The user sees a
 * minimal `read <path>` header and nothing for the result (compact mode).
 * The model still receives the full, unaltered file content via the built-in
 * `execute()` — including images, syntax-aware truncation, image hints.
 *
 * The user can press Ctrl+O in interactive mode to expand and see the
 * content with syntax highlighting. Errors are always shown (no compact).
 *
 * Trade-off:
 * - Default ON (opt-out via PI_EDIT_GUARD_RAW_READ=0). Reasoning: this fixes
 *   the surrender pattern, which is the primary failure mode we protect
 *   against. Users who want the built-in visual can opt out.
 * - We lose the default visual rendering of file contents. Users wanting
 *   to read a file "with their eyes" need to expand with Ctrl+O.
 * - We KEEP: image attachments, truncation warnings, syntax highlighting
 *   (on expand), auto-resize, image hints — all of these come from the
 *   built-in `execute()` which we re-use verbatim.
 *
 * Inspired by gentle-pi's `quiet-tools` approach: hide the visual noise,
 * keep the model's access to the data intact.
 *
 * Why no `Text` import:
 * `pi-tui` is a nested dependency of `pi-coding-agent` and not exported
 * from the package's public exports map. We never need to *instantiate*
 * Text — we only mutate the `lastComponent` the runtime hands us and
 * return plain objects that satisfy the runtime's Component interface.
 * This keeps the extension compatible with `pnpm test` and other consumers
 * that don't have `pi-tui` on the module path.
 *
 * Why we use the wrapped tool, not the raw definition:
 * `createReadTool()` returns the wrapped tool, which exposes `execute()`
 * but hides `renderCall`/`renderResult`. The wrapping is internal to the
 * runtime; we can't access the original definition cleanly. So instead of
 * delegating to the built-in renderer (we can't), we implement our own
 * minimal rendering for the expanded case: show the raw file content
 * plus the truncation warning if present. This trades syntax highlighting
 * in expanded view for simplicity, but the model already sees the raw
 * content via `execute()` so nothing important is lost.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createReadTool } from '@earendil-works/pi-coding-agent';

/**
 * Minimal Component shape we use. Matches the runtime's expectations:
 * - `setText(text)` for in-place text updates on a reused component.
 * - `render(width)` returning string[] for terminal output.
 *
 * We never instantiate this ourselves; the runtime provides the actual
 * `lastComponent`. The local declaration exists only for TypeScript.
 */
type ComponentLike = {
	setText: (text: string) => void;
	render: (width: number) => string[];
	invalidate: () => void;
};

type ReadToolResultLike = {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: { truncation?: { truncated?: boolean; outputLines?: number; totalLines?: number } };
};

/**
 * Build an empty component for compact mode (no visible output).
 */
function emptyComponent(): ComponentLike {
	return {
		setText(_text: string): void {
			// Compact: ignore text. The render() returns no lines.
		},
		render(_width: number): string[] {
			return [];
		},
		invalidate(): void {
			// No cached state to invalidate.
		},
	};
}

/**
 * Build a plain-text component for the expanded / error fallback.
 * Shows the raw file content plus the truncation warning. No syntax
 * highlighting (we lost access to the built-in renderer when `createReadTool`
 * returned the wrapped tool without `renderResult`).
 *
 * The runtime's chat container pads this with some whitespace, but the
 * padding is consistent and predictable. Users who care about exact
 * whitespace should look at the source file (or use bash/grep).
 */
function plainTextComponent(text: string): ComponentLike {
	const lines = text.split('\n');
	return {
		setText(newText: string): void {
			// Replace lines if the runtime mutates us after construction.
			const newLines = newText.split('\n');
			lines.length = 0;
			lines.push(...newLines);
		},
		render(width: number): string[] {
			return lines.map((line) => {
				if (line.length <= width) return line;
				return line.slice(0, width);
			});
		},
		invalidate(): void {
			// No cached state to invalidate.
		},
	};
}

/**
 * Format the truncation notice for the expanded view. Mirrors what the
 * built-in produces (so users aren't surprised by wording), minus the
 * ANSI colors that we can't easily reproduce without `pi-tui`.
 */
function truncationNotice(details: ReadToolResultLike['details']): string {
	const truncation = details?.truncation;
	if (!truncation?.truncated) return '';
	const total = truncation.totalLines ?? truncation.outputLines ?? '?';
	const shown = truncation.outputLines ?? '?';
	const maxBytes = (truncation as { maxBytes?: number }).maxBytes;
	if (maxBytes !== undefined) {
		return `[Truncated: showing ${shown} lines (${maxBytes} byte limit)]`;
	}
	return `[Truncated: showing ${shown} of ${total} lines (line limit)]`;
}

/**
 * Register the raw read tool override.
 *
 * Must be called before any `tool_call` / `tool_result` hooks fire on the
 * `edit` tool, so the override is installed before the first read.
 */
export function registerRawReadTool(pi: ExtensionAPI, cwd: string): void {
	const builtInRead = createReadTool(cwd, undefined);

	pi.registerTool({
		name: 'read',
		label: 'read',
		description: builtInRead.description,
		parameters: builtInRead.parameters,

		// Use the built-in execute() so images, syntax-aware truncation,
		// image hints, and auto-resize all work unchanged. The model
		// receives the file content with EXACT whitespace via this path.
		execute: builtInRead.execute,

		// Critical: renderShell: "self" tells the runtime to skip the
		// Box(paddingX=1) wrapper that adds the ~4-space TUI padding.
		// Without this, every line of our rendered output would be
		// padded with extra leading spaces that the model mistakes for
		// actual file content.
		renderShell: 'self',

		// Minimal call header: just `read <path>`.
		//
		// We must produce a renderable component even when the runtime does not
		// provide `lastComponent` (first call of a session, or certain render
		// paths). `emptyComponent()` is intentionally a no-op for the COMPACT
		// result, so using it here would make the header disappear entirely.
		// `plainTextComponent` is the fallback so the user always sees the
		// `read <path>` line, regardless of whether the runtime handed us a
		// component to mutate or we have to build one from scratch.
		renderCall(args: { path?: string; file_path?: string }, _theme: unknown, context: { lastComponent?: unknown }) {
			const path = args?.path ?? args?.file_path ?? '...';
			const text = `read ${path}`;
			const component = (context.lastComponent as ComponentLike | undefined) ?? plainTextComponent(text);
			component.setText(text);
			return component;
		},

		// Compact mode by default: empty component renders to zero lines,
		// so the user sees nothing for the result.
		// - Model still has the content (via execute above).
		// - User can press Ctrl+O to expand and see plain-text content.
		// - Errors always render in full (no compact) so failures are visible.
		renderResult(
			_result: unknown,
			options: { expanded?: boolean },
			_theme: unknown,
			context: { lastComponent?: unknown; isError?: boolean },
		) {
			if (!options.expanded && !context.isError) {
				// Compact: nothing visible. Model still has the content.
				return emptyComponent();
			}

			// Expanded or error: show raw content + truncation notice.
			// We don't have access to the built-in renderResult (the
			// wrapper hides it), so we render plain text. The user
			// asked to see the content by expanding; plain text is
			// better than nothing.
			const result = _result as ReadToolResultLike | undefined;
			const textBlock = result?.content?.find((c) => c.type === 'text');
			const body = textBlock?.text ?? '';
			const notice = truncationNotice(result?.details);
			const fullText = notice ? `${body}\n\n${notice}` : body;
			return plainTextComponent(fullText);
		},
	});
}