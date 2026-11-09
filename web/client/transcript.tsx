// Transcript renderer: history entries, optimistic user messages, the live
// streaming reply, and the working indicator. Assistant text renders as
// markdown; tool calls render as collapsible rows joined with their results.
// The transcript stays pinned to the bottom while the user is there, and a
// jump-to-latest button appears whenever they scroll up.

import { useEffect, useRef, useState } from "react";
import type { AssistantBlock, BashBlock, ImageBlock, ToolCallBlock } from "./streaming.ts";
import type { HistoryEntryLike, ToolCallStatus, ToolResultLike } from "./use-session.ts";
import type { WorkingModelLike } from "./plugins/contract.ts";
import { MarkdownBody } from "./plugins/markdown.tsx";

const RESULT_PREVIEW_LIMIT = 8_000;
const BASH_OUTPUT_PREVIEW_LIMIT = 8_000;
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

/** Shell-like tool names whose input is a command to show as `$ cmd`. */
const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "ssh"]);

interface ToolInputView {
  /** A shell command shown as `$ cmd`, when the tool takes one. */
  command?: string;
  /** Other parameters worth a dim line (timeout, path…). */
  params?: string;
  /** The full input, pretty-printed JSON or verbatim. */
  json?: string;
  /** A single file path the tool acts on (edit, read, write…). */
  file?: string;
}

/**
 * How a tool call's input is best displayed: bash shows its command, edit
 * shows the path (the diff comes from the result), everything else the
 * pretty JSON.
 */
function toolInputView(toolName: string, input: string): ToolInputView {
  if (input === "") return {};
  const name = toolName.toLowerCase();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return { json: input };
  }
  if (parsed === null || typeof parsed !== "object") return { json: input };
  if (SHELL_TOOLS.has(name)) {
    const command = typeof parsed.command === "string"
      ? parsed.command
      : (typeof parsed.cmd === "string" ? parsed.cmd : undefined);
    if (command !== undefined) {
      const extras = Object.entries(parsed)
        .filter(([key]) => key !== "command" && key !== "cmd")
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      return { command, ...(extras !== "" ? { params: extras } : {}) };
    }
  }
  if (typeof parsed.path === "string" && parsed.path !== "") {
    // File tools: the path is the headline; edits' old/new text would only
    // duplicate the diff the result carries.
    const rest = Object.entries(parsed)
      .filter(([key]) => key !== "path")
      .map(([key, value]) => `${key}=${JSON.stringify(value).slice(0, 120)}`)
      .join(" ");
    return { file: parsed.path, ...(rest !== "" ? { params: rest } : {}) };
  }
  return { json: prettyRawInput(input) };
}

/** The edit tool's diff: `+N line` / `-N line` / context, colored per line. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.slice(0, RESULT_PREVIEW_LIMIT).split("\n");
  return (
    <pre className="msg-diff">
      {lines.map((line, index) => (
        <span
          key={index}
          className={`msg-diff-line${line.startsWith("+") ? " is-add" : line.startsWith("-") ? " is-remove" : ""}`}
        >
          {line === "" ? "\u00a0" : line}
        </span>
      ))}
    </pre>
  );
}

/** An inline image (user attachments, tool results); click opens it full-size. */
function ImageBlockView({ block }: { block: ImageBlock }) {
  const src = `data:${block.mimeType};base64,${block.data}`;
  return (
    <a className="msg-image" href={src} target="_blank" rel="noopener noreferrer" title="Open image full-size">
      <img src={src} alt="attached image" />
    </a>
  );
}

/** A user-run `!` bash command from the TUI: command, streamed output, exit code. */
function BashBlockView({ block }: { block: BashBlock }) {
  // Expanded by default (same rule as tool rows); collapsible for long output.
  const [open, setOpen] = useState(true);
  const exit = block.exitCode;
  // A live row has no exit code yet; a cancelled one is final.
  const running = exit === undefined && block.cancelled !== true;
  const hasBody = block.output !== "";
  return (
    <div className={`msg-bash${running ? " is-running" : ""}`}>
      <button
        type="button"
        className="msg-bash-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={open ? "Collapse output" : "Expand output"}
      >
        <span className="msg-bash-prompt" aria-hidden="true">$</span>
        <code className="msg-bash-command">{block.command}</code>
        {running ? (
          <span className="msg-toolcall-running">running…</span>
        ) : (
          <span className={`msg-bash-exit${exit !== undefined && exit !== 0 ? " is-error" : ""}`}>
            {block.cancelled === true ? "cancelled" : `exit ${exit ?? "?"}`}
          </span>
        )}
        {hasBody ? (
          <span className="msg-toolcall-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        ) : null}
      </button>
      {open && hasBody ? (
        <pre className="msg-bash-output">{block.output.slice(0, BASH_OUTPUT_PREVIEW_LIMIT)}</pre>
      ) : null}
    </div>
  );
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
  // Expanded by default (the command and diff are the point of the row);
  // collapsible for long output.
  const [open, setOpen] = useState(true);
  const state = status?.state ?? (result ? (result.isError ? "error" : "done") : "done");
  // The input shown: the block's raw input, or the parsed args captured at
  // execution start (pi's live message_end carries arguments, and history
  // carries rawInput — either can be missing on the other path).
  const input = block.rawInput !== "" ? block.rawInput : (status?.input ?? "");
  const view = toolInputView(block.toolName, input);
  const hasBody = Boolean(input) || Boolean(result) || Boolean(status?.partial);

  const head = (
    <>
      <span className="msg-toolcall-state" aria-hidden="true" />
      <span className="msg-toolcall-name">{block.toolName}</span>
      {view.file !== undefined ? <code className="msg-toolcall-file">{view.file}</code> : null}
      {view.command !== undefined ? <code className="msg-toolcall-command-inline">{view.command}</code> : null}
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
          {view.command !== undefined ? (
            <pre className="msg-toolcall-command">
              <span className="msg-bash-prompt" aria-hidden="true">$</span> {view.command}
            </pre>
          ) : null}
          {view.params !== undefined ? (
            <div className="msg-toolcall-params">{view.params}</div>
          ) : null}
          {view.json !== undefined ? (
            <pre className="msg-toolcall-input">{view.json}</pre>
          ) : null}
          {status?.partial !== undefined && status.partial !== "" && state === "running" ? (
            <pre className="msg-toolcall-result is-partial">{status.partial.slice(0, RESULT_PREVIEW_LIMIT)}</pre>
          ) : null}
          {result?.diff !== undefined ? <DiffView diff={result.diff} /> : null}
          {result ? (
            <>
              <pre className={`msg-toolcall-result${result.isError ? " is-error" : ""}`}>
                {result.text.slice(0, RESULT_PREVIEW_LIMIT)}
              </pre>
              {result.images?.map((image, index) => (
                <ImageBlockView key={index} block={{ kind: "image", ...image }} />
              ))}
            </>
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
  live,
}: {
  blocks: AssistantBlock[];
  toolStatus: Record<string, ToolCallStatus>;
  toolResults: Record<string, ToolResultLike>;
  /** Inside the live streaming message: thinking renders expanded. */
  live?: boolean;
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
            <details key={index} className="msg-thinking" open={live === true}>
              <summary>{live === true ? "thinking…" : "thinking"}</summary>
              <div className="msg-thinking-body">{block.thinking}</div>
            </details>
          );
        }
        if (block.kind === "image") {
          return <ImageBlockView key={index} block={block} />;
        }
        if (block.kind === "bash") {
          return <BashBlockView key={index} block={block} />;
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

export interface TranscriptEntry {
  key: string;
  role: "user" | "assistant";
  blocks: AssistantBlock[];
  aborted?: boolean;
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

/** The user side: text paragraphs, attached images, `!` bash rows. */
function UserBlocks({ blocks }: { blocks: AssistantBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "text") {
          return (
            <p key={index} className="msg-text">
              {block.text}
            </p>
          );
        }
        if (block.kind === "image") {
          return <ImageBlockView key={index} block={block} />;
        }
        if (block.kind === "bash") {
          return <BashBlockView key={index} block={block} />;
        }
        return null;
      })}
    </>
  );
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

  const entries: TranscriptEntry[] = [
    ...history.map((entry, index) => ({
      key: `history-${index}`,
      role: entry.role,
      blocks: entry.blocks,
      ...(entry.aborted === true ? { aborted: true } : {}),
    })),
    ...userMessages.map((message) => ({
      key: `user-${message.key}`,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: message.text }],
    })),
  ];

  // Auto-scroll: while the user is at the bottom, every content change
  // (history load, streamed delta, thinking, working line) keeps the newest
  // content in view — that visible motion is what makes the stream feel
  // realtime.
  const streamedLength =
    streaming.streamingMessage?.content.reduce(
      (total, block) => total + (block.kind === "text" ? block.text.length : block.kind === "thinking" ? block.thinking.length : 0),
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
              ? <UserBlocks blocks={entry.blocks} />
              : (
                <>
                  <AssistantBlocks
                    blocks={entry.blocks}
                    toolStatus={toolStatus}
                    toolResults={toolResults}
                  />
                  {entry.aborted === true ? <div className="msg-aborted">⏹ interrupted</div> : null}
                </>
              )}
          </div>
        ))}
        {streaming.isStreaming && streaming.streamingMessage !== null ? (
          <div className="msg msg-assistant msg-streaming">
            <AssistantBlocks
              blocks={streaming.streamingMessage.content}
              toolStatus={toolStatus}
              toolResults={toolResults}
              live
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
