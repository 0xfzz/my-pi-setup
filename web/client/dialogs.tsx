// The web port of pi's TUI dialogs: the model picker (a searchable selector
// like the TUI's /model), the thinking-level picker, and the generic info
// dialog (session info, changelog). Plus DialogLayer — the extension surface
// for web dialogs: any extension can publish a `dialog` view and its actions
// dispatch through the plugin action pipeline, which is what makes the web
// UI itself extensible.

import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "./plugins/markdown.tsx";
import { postPluginAction } from "./plugins/actionClient.ts";
import type { DialogWebView } from "./plugins/contract.ts";

export interface ModelRefLike {
  provider: string;
  id: string;
}

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Shared modal frame: scrim, centered panel, Esc closes, title header. */
function DialogFrame({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="app-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className={`app-dialog${wide === true ? " app-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="app-dialog-head">
          <span className="app-dialog-title">{title}</span>
        </div>
        <div className="app-dialog-body">{children}</div>
        {footer !== undefined ? <div className="app-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** The web model picker: search, keyboard navigation, current marker. */
/**
 * The /tree picker: pi's session tree (getTree, projected like its TUI
 * selector — user/assistant/tool nodes, branch structure, the current
 * leaf) rendered as a searchable, keyboard-navigable tree. Enter
 * navigates to the highlighted node (pi's navigateTree).
 */
export function TreeSelectorDialog({
  nodes,
  onPick,
  onClose,
}: {
  nodes: Array<{
    entryId: string;
    label: string;
    role: "user" | "assistant" | "tool" | "bash" | "compaction" | "summary" | "other";
    depth: number;
    isCurrent: boolean;
    isBranch: boolean;
    timestamp?: string;
  }>;
  onPick: (entryId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? nodes
      : nodes.filter((node) => node.label.toLowerCase().includes(needle));
  }, [nodes, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  // The current leaf starts highlighted — Enter re-confirms the position,
  // like the TUI's selector opening on the leaf.
  useEffect(() => {
    const currentIdx = results.findIndex((node) => node.isCurrent);
    if (currentIdx >= 0) setIndex(currentIdx);
  }, [nodes]);

  // Keep the highlighted row in view while navigating.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${Math.min(index, Math.max(results.length - 1, 0))}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [index, results.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => Math.min(value + 1, results.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => Math.max(value - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const node = results[Math.min(index, results.length - 1)];
        if (node !== undefined) onPick(node.entryId);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, results, onPick, onClose]);

  const roleClass = (role: string): string =>
    role === "user"
      ? "app-tree-role-user"
      : role === "assistant"
        ? "app-tree-role-assistant"
        : role === "bash"
          ? "app-tree-role-bash"
          : "app-tree-role-other";

  return (
    <DialogFrame
      title={`Session tree — ${results.length}/${nodes.length} nodes`}
      onClose={onClose}
      wide
      footer={
        <span className="app-dialog-hint">
          {results.length > 0 ? "enter navigate · esc close · type to filter" : "esc close"}
        </span>
      }
    >
      <input
        ref={inputRef}
        className="app-model-search"
        type="text"
        placeholder="Filter the tree…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="app-tree-list" ref={listRef}>
        {results.length === 0
          ? <div className="app-tree-empty">no nodes match "{query}"</div>
          : results.map((node, i) => (
            <button
              key={node.entryId}
              type="button"
              className={`app-tree-node${i === index ? " is-highlighted" : ""}${node.isCurrent ? " is-current" : ""}`}
              data-index={i}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(node.entryId)}
              title={node.timestamp ?? undefined}
            >
              <span className="app-tree-structure" aria-hidden="true">
                {`${"│ ".repeat(node.depth)}${node.isBranch ? "◇" : "·"}`}
              </span>
              <span className={`app-tree-label ${roleClass(node.role)}`}>{node.label}</span>
              {node.isCurrent ? <span className="app-tree-current">● current</span> : null}
            </button>
          ))}
      </div>
    </DialogFrame>
  );
}

export function ModelPickerDialog({
  models,
  current,
  onPick,
  onClose,
  busy,
  error,
}: {
  models: ModelRefLike[];
  current?: ModelRefLike;
  onPick: (provider: string, id: string) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle === ""
      ? models
      : models.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(needle));
    // The current model sorts first so Enter keeps it.
    return list.sort((a, b) => {
      const aCurrent = current !== undefined && a.provider === current.provider && a.id === current.id;
      const bCurrent = current !== undefined && b.provider === current.provider && b.id === current.id;
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
    });
  }, [models, query, current]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  // Keep the highlighted row in view while navigating.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${Math.min(index, Math.max(results.length - 1, 0))}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [index, results.length]);

  const pick = (model: ModelRefLike): void => {
    onPick(model.provider, model.id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((value) => (value + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((value) => (value - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(results[Math.min(index, results.length - 1)]);
    }
  };

  return (
    <DialogFrame
      title="Model"
      onClose={onClose}
      footer={
        <span className="app-dialog-hint">
          {busy === true ? "applying…" : "↑↓ move · enter select · esc close"}
        </span>
      }
    >
      {error !== null && error !== undefined ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      <input
        ref={inputRef}
        className="app-dialog-search"
        type="text"
        value={query}
        placeholder="Search models (provider/id)…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Search models"
      />
      <div className="app-dialog-list" ref={listRef} role="listbox" aria-label="Models">
        {results.length === 0 ? (
          <div className="app-dialog-empty">
            {models.length === 0 ? "No models posted by this session yet." : "No matches."}
          </div>
        ) : results.map((model, position) => {
          const isCurrent = current !== undefined && model.provider === current.provider && model.id === current.id;
          return (
            <button
              key={`${model.provider}/${model.id}`}
              type="button"
              role="option"
              aria-selected={position === index}
              data-index={position}
              className={`app-dialog-item${position === index ? " is-active" : ""}${isCurrent ? " is-current" : ""}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => pick(model)}
            >
              <span className="app-dialog-item-provider">{model.provider}</span>
              <span className="app-dialog-item-id">{model.id}</span>
              {isCurrent ? <span className="app-dialog-item-current">current</span> : null}
            </button>
          );
        })}
      </div>
    </DialogFrame>
  );
}

/** The web thinking-level picker. */
export function ThinkingPickerDialog({
  current,
  onPick,
  onClose,
}: {
  current?: string;
  onPick: (level: string) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() => {
    const found = THINKING_LEVELS.findIndex((level) => level === current);
    return found >= 0 ? found : 0;
  });

  useEffect(() => {
    // Ignore the keystroke that opened this dialog: React flushes the
    // mount during that very keydown's bubble phase, so a listener
    // registered here would see it and pick immediately.
    const mountedAt = performance.now();
    const onKey = (event: KeyboardEvent): void => {
      if (event.timeStamp <= mountedAt) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIndex((value) => (value + 1) % THINKING_LEVELS.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((value) => (value - 1 + THINKING_LEVELS.length) % THINKING_LEVELS.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        onPick(THINKING_LEVELS[index]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onPick]);

  return (
    <DialogFrame
      title="Thinking level"
      onClose={onClose}
      footer={<span className="app-dialog-hint">↑↓ move · enter select · esc close</span>}
    >
      <div className="app-dialog-list" role="listbox" aria-label="Thinking levels">
        {THINKING_LEVELS.map((level, position) => (
          <button
            key={level}
            type="button"
            role="option"
            aria-selected={position === index}
            data-index={position}
            className={`app-dialog-item${position === index ? " is-active" : ""}${level === current ? " is-current" : ""}`}
            onMouseEnter={() => setIndex(position)}
            onClick={() => onPick(level)}
          >
            <span className="app-dialog-item-id">{level}</span>
            {level === current ? <span className="app-dialog-item-current">current</span> : null}
          </button>
        ))}
      </div>
    </DialogFrame>
  );
}

/** A document dialog: markdown body (changelog) or plain lines (session info). */
export function InfoDialog({
  title,
  markdown,
  lines,
  onClose,
}: {
  title: string;
  markdown?: string;
  lines?: string[];
  onClose: () => void;
}) {
  return (
    <DialogFrame title={title} onClose={onClose} wide footer={<span className="app-dialog-hint">esc close</span>}>
      {markdown !== undefined ? (
        <div className="app-dialog-markdown">
          <MarkdownBody text={markdown} />
        </div>
      ) : (
        <pre className="app-dialog-lines">{(lines ?? []).join("\n")}</pre>
      )}
    </DialogFrame>
  );
}

/**
 * Dialog views published by extensions: the extension surface for web
 * popups. Actions dispatch through the plugin action pipeline; the extension
 * closes a dialog by publishing the view with `open: false`.
 */
export function DialogLayer({
  pluginViews,
  sessionId,
  dismissed,
  onDismiss,
}: {
  pluginViews: Record<string, unknown>;
  sessionId: string | null;
  /** Client-side dismissals: dialogId → the dismissed view object. A new
   * publish (a different object) shows the dialog again; the extension's
   * own close path is open: false. */
  dismissed: ReadonlyMap<string, unknown>;
  onDismiss?: (dialogId: string, view: unknown) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const entries = Object.entries(pluginViews).filter(([, view]) => {
    if (typeof view !== "object" || view === null) return false;
    if ((view as { type?: unknown }).type !== "dialog") return false;
    if ((view as { open?: unknown }).open === false) return false;
    // Dismissed and not re-published since: stay hidden.
    const dialogId = viewDialogId((view as { id?: unknown }).id) ?? null;
    return !(dialogId !== null && dismissed.get(dialogId) === view);
  }) as Array<[string, DialogWebView & { id?: string }]>;

  if (entries.length === 0 || sessionId === null) return null;

  const runAction = async (pluginId: string, action: { id: string }): Promise<void> => {
    setBusy(action.id);
    try {
      const { data } = await postPluginAction(sessionId, pluginId, action);
      if (!data.ok) {
        // Surface the failure where the user just clicked.
        window.dispatchEvent(new CustomEvent("pi-web:dialog-error", { detail: data.error ?? "action failed" }));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {entries.map(([pluginId, view]) => {
        const dialogId = viewDialogId(view.id) ?? pluginId;
        return (
          <div key={dialogId} className="app-dialog-backdrop">
            <div className="app-dialog" role="dialog" aria-modal="true" aria-label={view.title ?? dialogId}>
              <div className="app-dialog-head">
                <span className="app-dialog-title">{view.title ?? dialogId}</span>
                {onDismiss !== undefined ? (
                  <button
                    type="button"
                    className="app-dialog-close"
                    aria-label="Dismiss dialog"
                    onClick={() => onDismiss(dialogId, view)}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <div className="app-dialog-body">
                {view.body !== undefined ? (
                  <div className="app-dialog-markdown">
                    <MarkdownBody text={view.body} />
                  </div>
                ) : null}
                {view.lines !== undefined ? (
                  <pre className="app-dialog-lines">{view.lines.join("\n")}</pre>
                ) : null}
              </div>
              {view.actions !== undefined && view.actions.length > 0 ? (
                <div className="app-dialog-foot app-dialog-actions">
                  {view.actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={`app-dialog-action app-dialog-action-${action.tone ?? "default"}`}
                      disabled={busy === action.id}
                      onClick={() => {
                        void runAction(pluginId, action);
                      }}
                    >
                      {busy === action.id ? "…" : action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Stable per-dialog identity for dismissals. */
export function viewDialogId(id: unknown): string | null {
  return typeof id === "string" && id !== "" ? id : null;
}
