// Transcript renderer: history entries, optimistic user messages, the live
// streaming reply, and the working indicator. Assistant text renders as
// markdown; tool calls render as collapsible rows joined with their results.
// The transcript stays pinned to the bottom while the user is there, and a
// jump-to-latest button appears whenever they scroll up.

import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, CaretDown, CaretRight, Stop, Warning } from "@phosphor-icons/react";
import type { AssistantBlock, BashBlock, ImageBlock, ToolCallBlock } from "./streaming.ts";
import type { HistoryEntryLike, ToolCallStatus, ToolResultLike } from "./use-session.ts";
import type { WebPluginDescriptor, WebView, WorkingModelLike } from "./plugin-system/contract.ts";
import { compactionMarkerLabel } from "./compaction.ts";
import { ComponentOverrideHost } from "./plugin-system/ComponentOverrideHost.tsx";
import { MarkdownBody } from "./plugin-system/markdown.tsx";
import { LoadingSpinner } from "./plugin-system/LoadingSpinner.tsx";
import { inlineLoading } from "./inline-loading.ts";
import { assistantBlocksPropsEqual } from "./tool-block-memo.ts";
import { INITIAL_FOLLOW, reduceFollow, type FollowEvent, type FollowState, type ScrollMetrics } from "./transcript-follow.ts";

const RESULT_PREVIEW_LIMIT = 8_000;

/**
 * Asks the session to fetch one tool result in full (its images, which the
 * history leaves out until the call is expanded). Null outside a transcript.
 */
const ToolResultLoadContext = createContext<((toolCallId: string) => void) | null>(null);
const BASH_OUTPUT_PREVIEW_LIMIT = 8_000;
const DEFAULT_WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The transcript's working line: animated frames plus the streamed message. */
export function WorkingIndicator({
  working,
  fallback,
  label,
}: {
  working: WorkingModelLike | null;
  fallback: string;
  /**
   * Wins over the working model's own message. A compaction is not the
   * plugin's work, so its status line has to replace "Ratiocinating..." rather
   * than defer to it.
   */
  label?: string;
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

  const frameColor = working?.frameColors?.[frameIndex];
  const message = label ?? working?.message ?? fallback;
  // The plugin's styled segments describe its own words; a replacement label
  // renders as plain text.
  // The word's wave arrives once as a cycle; this indicator loops it on its own
  // timer, so the transcript does not re-render per tick.
  const cycle = working?.messageFrames ?? null;
  const cycleLength = cycle?.length ?? 0;
  const cycleIntervalMs = working?.messageIntervalMs ?? 120;
  const [cycleTick, setCycleTick] = useState(0);
  useEffect(() => {
    if (cycleLength < 2) return;
    const timer = setInterval(() => setCycleTick((tick) => tick + 1), cycleIntervalMs);
    return () => clearInterval(timer);
  }, [cycleLength, cycleIntervalMs]);
  const cycleSegments = cycle !== null && cycleLength > 0 ? cycle[cycleTick % cycleLength] : undefined;
  const segments = label !== undefined ? undefined : (cycleSegments ?? working?.messageSegments);
  return (
    <span className="plugin-working-line">
      <span
        className="plugin-working-frame"
        aria-hidden="true"
        style={frameColor ? ({ "--working-frame-color": frameColor } as CSSProperties) : undefined}
      >
        {frames[frameIndex] ?? ""}
      </span>
      {segments?.length ? (
        <span className="plugin-working-message">
          {segments.map((segment, index) => (
            <span
              key={index}
              className={segment.bold ? "plugin-working-segment plugin-working-segment--bold" : "plugin-working-segment"}
              style={segment.color ? ({ "--working-segment-color": segment.color } as CSSProperties) : undefined}
            >
              {segment.text}
            </span>
          ))}
        </span>
      ) : (
        message
      )}
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
        aria-label={running ? "Bash command running, toggle output" : "Bash command, toggle output"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={open ? "Collapse output" : "Expand output"}
      >
        <span className="msg-bash-prompt" aria-hidden="true">$</span>
        <code className="msg-bash-command">{block.command}</code>
        {running ? (
          <span className="msg-toolcall-running">running…</span>
        ) : (
          <span
            className={`msg-bash-exit${
              exit === undefined ? "" : exit !== 0 ? " is-error" : " is-ok"
            }`}
          >
            {block.cancelled === true ? "cancelled" : `exit ${exit ?? "?"}`}
          </span>
        )}
        {hasBody ? (
          <span className="msg-toolcall-chevron" aria-hidden="true">{open ? <CaretDown size={12} /> : <CaretRight size={12} />}</span>
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
  // Expanded by default (the command and diff are the point of the row), except
  // a result with screenshots: those start collapsed, so a long session's
  // history does not render every image at once. Collapsible for long output.
  const [open, setOpen] = useState(() => result?.hasImages !== true);
  const loadToolResult = useContext(ToolResultLoadContext);
  const imagesPending = result?.hasImages === true && result.images === undefined;
  useEffect(() => {
    if (open && imagesPending) loadToolResult?.(block.toolCallId);
  }, [open, imagesPending, loadToolResult, block.toolCallId]);
  const state = status?.state ?? (result ? (result.isError ? "error" : "done") : "done");
  // The tool ran to completion with a clean result: green — the mirror of
  // the red error state, so success and failure read at a glance.
  const succeeded = state === "done" && result !== undefined && !result.isError;
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
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className={`msg-toolcall msg-toolcall-${state}${open ? " is-open" : ""}${
        succeeded ? " msg-toolcall-success" : ""
      }`}
      data-toolcall-id={block.toolCallId}
    >
      {hasBody ? (
        <button
          type="button"
          className="msg-toolcall-toggle"
          aria-label={`${block.toolName} tool call, toggle details`}
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
              <pre
                className={`msg-toolcall-result${
                  result.isError ? " is-error" : succeeded ? " is-success" : ""
                }`}
              >
                {result.text.slice(0, RESULT_PREVIEW_LIMIT)}
              </pre>
              {imagesPending ? <div className="msg-toolcall-loading">Loading screenshot…</div> : null}
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

export const AssistantBlocks = memo(function AssistantBlocks({
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
}, assistantBlocksPropsEqual);

export interface TranscriptEntry {
  key: string;
  role: "user" | "assistant";
  blocks: AssistantBlock[];
  aborted?: boolean;
  error?: string;
}

/**
 * A compaction boundary in the transcript. The marker is a divider, not a
 * message: it says where the context was replaced and how much it held, and
 * the summary that replaced it stays folded until asked for.
 */
interface TranscriptCompaction {
  kind: "compaction";
  key: string;
  /** The tokens the summary replaced; undefined when the count is missing. */
  tokensBefore?: number;
  summary: string;
  /** A failed compaction's reason. It has no summary — the entry marks the event. */
  error?: string;
}

/** One row of the transcript: a message, or a compaction boundary. */
type TranscriptItem =
  | ({ kind: "message" } & TranscriptEntry)
  | TranscriptCompaction;

export interface TranscriptUserMessage {
  key: number;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface TranscriptProps {
  history: HistoryEntryLike[];
  loading?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Fetch one tool result in full (see ToolResultLoadContext). */
  onLoadToolResult?: (toolCallId: string) => void;
  userMessages: TranscriptUserMessage[];
  streaming: { isStreaming: boolean; streamingMessage: { content: AssistantBlock[] } | null };
  toolStatus: Record<string, ToolCallStatus>;
  toolResults: Record<string, ToolResultLike>;
  working: WorkingModelLike | null;
  showWorking: boolean;
  /** Replaces the working line's text while a compaction runs. */
  workingLabel?: string;
  /** Plugin hosts for the `chat.working` anchor and the working-indicator override. */
  plugins?: readonly WebPluginDescriptor[];
  pluginViews?: Record<string, WebView> | null;
  /** Extra content mounted beside the working line (the `chat.working` anchor). */
  workingAnchor?: ReactNode;
}

/** The user side: text paragraphs, attached images, `!` bash rows. */
const UserBlocks = memo(function UserBlocks({ blocks }: { blocks: AssistantBlock[] }) {
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
});

/**
 * A compaction boundary: where pi replaced the earlier context with a summary.
 * Folded by default — the summary is the model's working notes, not the
 * conversation — but it is one click away, and the token count says how much
 * context it replaced. A failed compaction has no summary: the row carries
 * the reason instead, so an automatic compaction that gave up is visible
 * rather than silent.
 */
const CompactionMarker = memo(function CompactionMarker({
  tokensBefore,
  summary,
  error,
}: {
  tokensBefore?: number;
  summary: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasSummary = summary.trim() !== "";
  return (
    <div className={`msg-compaction${error !== undefined ? " is-error" : ""}`}>
      <div className="msg-compaction-head">
        <span className="msg-compaction-rule" aria-hidden="true" />
        {hasSummary ? (
          <button
            type="button"
            className="msg-compaction-label"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {compactionMarkerLabel(tokensBefore)}
            <span className="msg-compaction-chevron" aria-hidden="true">
              {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
            </span>
          </button>
        ) : (
          <span className="msg-compaction-label">{compactionMarkerLabel(tokensBefore)}</span>
        )}
      </div>
      {error !== undefined && error !== "" ? (
        <div className="msg-error"><Warning size={12} weight="fill" /> {error}</div>
      ) : null}
      {open && hasSummary ? <MarkdownBody text={summary} /> : null}
    </div>
  );
});

export function Transcript({
  history,
  loading = false,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadToolResult,
  userMessages,
  streaming,
  toolStatus,
  toolResults,
  working,
  showWorking,
  workingLabel,
  plugins,
  pluginViews,
  workingAnchor,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef<FollowState>(INITIAL_FOLLOW);
  const contentHeightRef = useRef(0);
  const sentCountRef = useRef(userMessages.length);
  const [showJump, setShowJump] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const olderAnchorRef = useRef<number | null>(null);

  const loadOlder = (): void => {
    const scroller = scrollRef.current;
    olderAnchorRef.current = scroller === null ? null : scroller.scrollHeight - scroller.scrollTop;
    onLoadOlder?.();
  };
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = olderAnchorRef.current;
    if (scroller === null || anchor === null) return;
    scroller.scrollTop = scroller.scrollHeight - anchor;
    olderAnchorRef.current = null;
  }, [history.length]);

  // While the history is loading, this transcript shows its own spinner; claim
  // that so the generic request card does not add a second one.
  useEffect(() => (loading ? inlineLoading.claim() : undefined), [loading]);

  const items: TranscriptItem[] = [
    ...history.map((entry, index): TranscriptItem => entry.role === "compaction"
      ? {
        kind: "compaction",
        key: `history-${index}`,
        summary: entry.summary ?? "",
        ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      }
      : {
        kind: "message",
        key: `history-${index}`,
        role: entry.role,
        blocks: entry.blocks,
        ...(entry.aborted === true ? { aborted: true } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      }),
    ...userMessages.map((message): TranscriptItem => ({
      kind: "message",
      key: `user-${message.key}`,
      role: "user",
      blocks: [
        ...(message.text.trim() !== "" ? [{ kind: "text" as const, text: message.text }] : []),
        ...(message.images ?? []).map((image) => ({
          kind: "image" as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
    })),
  ];

  // Follow the end (the policy lives in transcript-follow.ts). Layout drives
  // it, not a timer: the column growing is new content, and the scroller's own
  // resize (a plugin card opening above the composer) can unseat the end.
  const applyFollow = (event: FollowEvent): void => {
    const next = reduceFollow(followRef.current, event);
    followRef.current = next;
    setShowJump(!next.pinned);
    setHasUnread(next.unread);
  };

  const scrollToEnd = (): void => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (el === null || inner === null) return undefined;
    const observer = new ResizeObserver(() => {
      const height = inner.offsetHeight;
      if (height > contentHeightRef.current) applyFollow({ kind: "grew" });
      contentHeightRef.current = height;
      if (followRef.current.pinned) scrollToEnd();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // A prompt the reader sent lands at the end, wherever they were reading.
  useEffect(() => {
    const previous = sentCountRef.current;
    sentCountRef.current = userMessages.length;
    if (userMessages.length <= previous) return;
    applyFollow({ kind: "jumped" });
    scrollToEnd();
  }, [userMessages.length]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const metrics: ScrollMetrics = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
    applyFollow({ kind: "scrolled", metrics });
  };

  const jumpToLatest = (): void => {
    applyFollow({ kind: "jumped" });
    scrollToEnd();
  };

  return (
    <ToolResultLoadContext.Provider value={onLoadToolResult ?? null}>
      <main className="app-transcript" aria-busy={loading} ref={scrollRef} onScroll={handleScroll}>
        <div className="app-transcript-inner" ref={innerRef}>
          {hasOlder ? (
            <div className="app-history-pager">
              <button type="button" className="app-history-pager-button" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "Loading older messages…" : "Load older messages"}
              </button>
            </div>
          ) : null}
          {loading ? <div className="app-content-loading"><LoadingSpinner label="Loading conversation…" /></div> : null}
          {!loading && items.length === 0 && !streaming.isStreaming && !showWorking ? (
            <div className="app-empty">
              <span className="app-empty-mark" aria-hidden="true">pi</span>
              <h1>What are we working on?</h1>
              <p>Start a session, or pick up where you left off.</p>
            </div>
          ) : null}
          {items.map((item) => item.kind === "compaction" ? (
            <CompactionMarker
              key={item.key}
              tokensBefore={item.tokensBefore}
              summary={item.summary}
              error={item.error}
            />
          ) : (
            <div key={item.key} className={`msg msg-${item.role}`}>
              {item.role === "user"
                ? <UserBlocks blocks={item.blocks} />
                : (
                  <>
                    <AssistantBlocks
                      blocks={item.blocks}
                      toolStatus={toolStatus}
                      toolResults={toolResults}
                    />
                    {item.aborted === true ? <div className="msg-aborted"><Stop size={12} weight="fill" /> interrupted</div> : null}
                    {item.error !== undefined && item.error !== "" ? <div className="msg-error"><Warning size={12} weight="fill" /> {item.error}</div> : null}
                  </>
                )}
            </div>
          ))}
          {streaming.isStreaming && streaming.streamingMessage !== null ? (
            <div className="msg msg-assistant msg-streaming" aria-live="polite" aria-atomic="false">
              <AssistantBlocks
                blocks={streaming.streamingMessage.content}
                toolStatus={toolStatus}
                toolResults={toolResults}
                live
              />
            </div>
          ) : null}
          {showWorking ? (
            <div className="msg-working" role="status" aria-live="polite">
              <ComponentOverrideHost
                target="ui.working-indicator.v1"
                plugins={plugins ?? []}
                views={pluginViews}
              >
                <WorkingIndicator working={working} fallback="pi is working..." label={workingLabel} />
              </ComponentOverrideHost>
              {workingAnchor}
            </div>
          ) : null}
        </div>
      </main>
      {showJump ? (
        <button
          type="button"
          className={`app-jump-latest${hasUnread ? " has-unread" : ""}`}
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          title="Jump to latest"
        >
          <ArrowDown size={14} weight="bold" /> {hasUnread ? "new messages" : "latest"}
        </button>
      ) : null}
    </ToolResultLoadContext.Provider>
  );
}
