// Transcript renderer: history entries, optimistic user messages, the live
// streaming reply, and the working indicator. Assistant text renders as
// markdown; tool calls render as collapsible rows joined with their results.
// The transcript stays pinned to the bottom while the user is there, and a
// jump-to-latest button appears whenever they scroll up.

import { useEffect, useRef, useState } from "react";
import type { AssistantBlock, ToolCallBlock } from "./streaming.ts";
import type { HistoryEntryLike, ToolCallStatus, ToolResultLike } from "./use-session.ts";
import type { WorkingModelLike } from "./plugins/contract.ts";
import { MarkdownBody } from "./plugins/markdown.tsx";

const RESULT_PREVIEW_LIMIT = 8000;
const DEFAULT_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Below this distance from the bottom the user counts as "at the bottom". */
const PIN_DISTANCE_PX = 48;

/** The transcript's working line: animated frames plus the streamed message. */
export function WorkingIndicator({
  working,
  fallback,
}: {
  working: WorkingModelLike | null;
  fallback: string;
}) {
  const frames = working?.frames ?? DEFAULT_WORKING_FRAMES;
  const intervalMs = working?.intervalMs ?? 80;
  const [frameIndex, setFrameIndex] = useState(0);
  const signature = frames.join("\u0000");

  useEffect(() => {
    if (frames.length < 2) return;
    const timer = setInterval(
      () => setFrameIndex((frame) => (frame + 1) % frames.length),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [signature, intervalMs, frames.length]);

  const message = working?.message ?? fallback;
  return (
    <span className="plugin-working-line">
      <span className="plugin-working-frame" aria-hidden="true">
        {frames[frameIndex] ?? ""}
      </span>
      {message}
    </span>
  );
}

/** Pretty-print JSON tool inputs; anything else stays verbatim. */
function prettyRawInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function ToolCallRow({
  block,
  status,
  result,
}: {
  block: ToolCallBlock;
  status?: ToolCallStatus;
  result?: ToolResultLike;
}) {
  const [open, setOpen] = useState(false);
  const state = status?.state ?? (result ? (result.isError ? "error" : "done") : "done");
  const hasBody = Boolean(block.rawInput) || Boolean(result);

  const head = (
    <>
      <span className="msg-toolcall-state" aria-hidden="true" />
      <span className="msg-toolcall-name">{block.toolName}</span>
      {state === "running" ? <span className="msg-toolcall-running">running…</span> : null}
      {state === "error" ? <span className="msg-toolcall-error-tag">failed</span> : null}
      {hasBody ? (
        <span className="msg-toolcall-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={`msg-toolcall msg-toolcall-${state}${open ? " is-open" : ""}`}
      data-toolcall-id={block.toolCallId}
    >
      {hasBody ? (
        <button
          type="button"
          className="msg-toolcall-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={open ? "Collapse tool call" : "Expand tool call"}
        >
          {head}
        </button>
      ) : (
        <div className="msg-toolcall-toggle msg-toolcall-static">{head}</div>
      )}
      {open ? (
        <div className="msg-toolcall-body">
          {block.rawInput ? (
            <pre className="msg-toolcall-input">{prettyRawInput(block.rawInput)}</pre>
          ) : null}
          {result ? (
            <pre className={`msg-toolcall-result${result.isError ? " is-error" : ""}`}>
              {result.text.slice(0, RESULT_PREVIEW_LIMIT)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AssistantBlocks({
  blocks,
  toolStatus,
  toolResults,
}: {
  blocks: AssistantBlock[];
  toolStatus: Record<string, ToolCallStatus>;
  toolResults: Record<string, ToolResultLike>;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block === undefined) return null;
        if (block.kind === "text") {
          return <MarkdownBody key={index} text={block.text} />;
        }
        if (block.kind === "thinking") {
          return (
            <details key={index} className="msg-thinking">
              <summary>thinking</summary>
              <div className="msg-thinking-body">{block.thinking}</div>
            </details>
          );
        }
        return (
          <ToolCallRow
            key={index}
            block={block}
            status={block.toolCallId ? toolStatus[block.toolCallId] : undefined}
            result={block.toolCallId ? toolResults[block.toolCallId] : undefined}
          />
        );
      })}
    </>
  );
}

export interface TranscriptProps {
  history: HistoryEntryLike[];
  userMessages: Array<{ key: number; text: string }>;
  streaming: { isStreaming: boolean; streamingMessage: { content: AssistantBlock[] } | null };
  toolStatus: Record<string, ToolCallStatus>;
  toolResults: Record<string, ToolResultLike>;
  working: WorkingModelLike | null;
  showWorking: boolean;
}

export function Transcript({
  history,
  userMessages,
  streaming,
  toolStatus,
  toolResults,
  working,
  showWorking,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const entries: Array<{ key: string; role: "user" | "assistant"; blocks: AssistantBlock[] }> = [
    ...history.map((entry, index) => ({
      key: `history-${index}`,
      role: entry.role,
      blocks: entry.blocks,
    })),
    ...userMessages.map((message) => ({
      key: `user-${message.key}`,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: message.text }],
    })),
  ];

  // Auto-scroll: while the user is at the bottom, every content change
  // (history load, streamed delta, working line) keeps the newest content in
  // view — that visible motion is what makes the stream feel realtime.
  const streamedLength =
    streaming.streamingMessage?.content.reduce(
      (total, block) => (block.kind === "text" ? total + block.text.length : total),
      0,
    ) ?? 0;
  const contentSignature = `${entries.length}:${streaming.isStreaming ? 1 : 0}:${streamedLength}:${showWorking ? 1 : 0}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [contentSignature]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distance < PIN_DISTANCE_PX;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setShowJump(false);
  };

  return (
    <main className="app-transcript" aria-live="polite" ref={scrollRef} onScroll={handleScroll}>
      <div className="app-transcript-inner">
        {entries.length === 0 && !streaming.isStreaming && !showWorking ? (
          <div className="app-empty">No messages yet.</div>
        ) : null}
        {entries.map((entry) => (
          <div key={entry.key} className={`msg msg-${entry.role}`}>
            {entry.role === "user"
              ? entry.blocks
                .filter((block): block is { kind: "text"; text: string } => block.kind === "text")
                .map((block, index) => (
                  <p key={index} className="msg-text">
                    {block.text}
                  </p>
                ))
              : (
                <AssistantBlocks
                  blocks={entry.blocks}
                  toolStatus={toolStatus}
                  toolResults={toolResults}
                />
              )}
          </div>
        ))}
        {streaming.isStreaming && streaming.streamingMessage !== null ? (
          <div className="msg msg-assistant msg-streaming">
            <AssistantBlocks
              blocks={streaming.streamingMessage.content}
              toolStatus={toolStatus}
              toolResults={toolResults}
            />
          </div>
        ) : null}
        {showWorking ? (
          <div className="msg-working">
            <WorkingIndicator working={working} fallback="pi is working…" />
          </div>
        ) : null}
      </div>
      {showJump ? (
        <button
          type="button"
          className="app-jump-latest"
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          title="Jump to latest"
        >
          <span aria-hidden="true">↓</span> latest
        </button>
      ) : null}
    </main>
  );
}
