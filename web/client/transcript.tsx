// Transcript renderer: history entries, optimistic user messages, the
// live streaming reply, and the working indicator. Tool calls render as
// status lines driven by the tool_execution_* wire events.

import { useEffect, useState } from "react";
import type { AssistantBlock, ToolCallBlock } from "./streaming.ts";
import type { HistoryEntryLike, ToolCallStatus } from "./use-session.ts";
import type { WorkingModelLike } from "./plugins/contract.ts";

const RAW_INPUT_PREVIEW_LIMIT = 400;
const DEFAULT_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function ToolCallLine({ block, status }: { block: ToolCallBlock; status?: ToolCallStatus }) {
  const state = status?.state ?? "done";
  return (
    <div className={`msg-toolcall msg-toolcall-${state}`}>
      <span className="msg-toolcall-name">{block.toolName}</span>
      {state === "running" ? <span className="msg-toolcall-dot" aria-label="running" /> : null}
      {state === "error" ? <span className="msg-toolcall-error-tag">failed</span> : null}
      {block.rawInput ? (
        <pre className="msg-toolcall-input">{truncate(block.rawInput, RAW_INPUT_PREVIEW_LIMIT)}</pre>
      ) : null}
    </div>
  );
}

export function AssistantBlocks({
  blocks,
  toolStatus,
}: {
  blocks: AssistantBlock[];
  toolStatus: Record<string, ToolCallStatus>;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block === undefined) return null;
        if (block.kind === "text") {
          return (
            <p key={index} className="msg-text">
              {block.text}
            </p>
          );
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
          <ToolCallLine
            key={index}
            block={block}
            status={block.toolCallId ? toolStatus[block.toolCallId] : undefined}
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
  working: WorkingModelLike | null;
  showWorking: boolean;
}

export function Transcript({ history, userMessages, streaming, toolStatus, working, showWorking }: TranscriptProps) {
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

  return (
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
            : <AssistantBlocks blocks={entry.blocks} toolStatus={toolStatus} />}
        </div>
      ))}
      {streaming.isStreaming && streaming.streamingMessage !== null ? (
        <div className="msg msg-assistant msg-streaming">
          <AssistantBlocks blocks={streaming.streamingMessage.content} toolStatus={toolStatus} />
        </div>
      ) : null}
      {showWorking ? (
        <div className="msg-working">
          <WorkingIndicator working={working} fallback="pi is working…" />
        </div>
      ) : null}
    </div>
  );
}
