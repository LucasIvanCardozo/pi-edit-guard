/**
 * In-place mutation of tool result events.
 *
 * Other extensions (e.g. gentle-pi's `quiet-tools`) register custom
 * renderers that read `result.content` directly. Returning a patch like
 * `{ content: [...] }` from `tool_result` would create a new object that
 * the custom renderer never sees. Mutating in-place lets the renderer
 * pick up our message.
 *
 * We also set `isError: false` so renderers like `quiet-tools` collapse
 * the output via `COLLAPSED_TAIL_LINE_LIMIT` (the model still receives
 * the full content — only the visual collapses).
 */

type MutableEvent = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export function mutateToolResult(event: MutableEvent, newText: string, isError: boolean): void {
  if (Array.isArray(event.content) && event.content.length > 0) {
    event.content[0] = { type: 'text', text: newText };
  } else {
    event.content = [{ type: 'text', text: newText }];
  }
  event.isError = isError;
}
