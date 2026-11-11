/**
 * Server-sent-event framing, extracted from the web extension's bridge
 * stream reader. The browser's EventSource handles standard channels, but the
 * TUI bridge reads its attach stream with a raw fetch, so it owns the
 * byte→frame boundary. These two pure steps are what that reader performs;
 * keeping them here makes them testable without a server.
 */

/**
 * Split a growing buffer into the frames terminated by a blank line, plus the
 * part of a frame that is still arriving. Frames are delimited by `\n\n`
 * exactly (SSE); `\r\n` line endings are not produced by our writers.
 */
export function takeSseFrames(buffer: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let remainder = buffer;
  let separator = remainder.indexOf("\n\n");
  while (separator >= 0) {
    frames.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 2);
    separator = remainder.indexOf("\n\n");
  }
  return { frames, remainder };
}

/**
 * The data payload of one frame: its `data:` lines joined by a newline, with
 * the one optional space after the colon trimmed. A heartbeat or comment
 * (no data lines) yields the empty string.
 */
export function sseFrameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
}