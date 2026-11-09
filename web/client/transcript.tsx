// Transcript renderer: history entries, optimistic user messages and the
// live streaming reply. Tool calls render as status lines driven by the
// tool_execution_* wire events.

import type { AssistantBlock, ToolCallBlock } from "./streaming.ts";
import type { HistoryEntryLike, ToolCallStatus } from "./use-session.ts";

const RAW_INPUT_PREVIEW_LIMIT = 400;

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
}

export function Transcript({ history, userMessages, streaming, toolStatus }: TranscriptProps) {
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
      {entries.length === 0 && !streaming.isStreaming ? (
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
      {streaming.isStreaming ? (
        <div className="msg-working">
          <span className="msg-working-dot" aria-label="working" />
          pi is working…
        </div>
      ) : null}
    </div>
  );
}
