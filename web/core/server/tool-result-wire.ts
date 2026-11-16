// The tool results a history response carries: only what the transcript can
// show before a tool call is expanded. The transcript renders at most
// HISTORY_RESULT_TEXT_LIMIT characters of a result's text or diff, and a
// result's images only inside its expanded body. Sending everything made a
// 37 MB session's history a 4 MB response, nearly all of it screenshots. The
// full result is served on demand by the tool-result route.

import type { ToolResultEntry } from "./sessions.ts";

/** Matches the transcript's preview limit (RESULT_PREVIEW_LIMIT in transcript.tsx). */
export const HISTORY_RESULT_TEXT_LIMIT = 8_000;

/** A tool result as the history response carries it. */
export interface WireToolResult {
  text: string;
  isError: boolean;
  diff?: string;
  /** The result has images; fetch them with the tool-result route when expanded. */
  hasImages?: boolean;
}

export function toWireToolResult(result: ToolResultEntry): WireToolResult {
  const wire: WireToolResult = {
    text: result.text.slice(0, HISTORY_RESULT_TEXT_LIMIT),
    isError: result.isError,
  };
  if (result.diff !== undefined) wire.diff = result.diff.slice(0, HISTORY_RESULT_TEXT_LIMIT);
  if (result.images !== undefined && result.images.length > 0) wire.hasImages = true;
  return wire;
}

export function toWireToolResults(results: Record<string, ToolResultEntry>): Record<string, WireToolResult> {
  return Object.fromEntries(
    Object.entries(results).map(([toolCallId, result]) => [toolCallId, toWireToolResult(result)]),
  );
}
