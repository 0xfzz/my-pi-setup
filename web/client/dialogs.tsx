// The web port of pi's TUI dialogs: the model picker (a searchable selector
// like the TUI's /model), the thinking-level picker, and the generic info
// dialog (session info, changelog). Plus DialogLayer — the extension surface
// for web dialogs: any extension can publish a `dialog` view and its actions
// dispatch through the plugin action pipeline, which is what makes the web
// UI itself extensible.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "@phosphor-icons/react";
import { MarkdownBody } from "./plugins/markdown.tsx";
import { postPluginAction } from "./plugins/actionClient.ts";
import type { DialogWebView } from "./plugins/contract.ts";
import type { PiAuthLoginState, PiSettingEntry, PiTrustState } from "../shared/pi-api.ts";

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
    text?: string;
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

  // The relative time, TUI-style: "2h", "3d".
  const relativeTime = (timestamp?: string): string => {
    if (timestamp === undefined) return "";
    const ms = Date.now() - Date.parse(timestamp);
    if (Number.isNaN(ms)) return "";
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  };

  const roleTag = (role: string): string =>
    role === "user"
      ? "user"
      : role === "assistant"
        ? "pi"
        : role === "bash"
          ? "bash"
          : role === "compaction"
            ? "compact"
            : role === "summary"
              ? "summary"
              : role === "tool"
                ? "tool"
                : "";

  return (
    <DialogFrame
      title="Session tree"
      onClose={onClose}
      wide
      footer={
        <span className="app-dialog-hint">
          {results.length > 0
            ? `${results.length}/${nodes.length} · enter navigate · esc close · type to filter`
            : "esc close"}
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
              data-depth={node.depth}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(node.entryId)}
              title={node.timestamp ?? undefined}
            >
              {/* The git-graph guides: one cell per ancestor level, the
                  last carrying the arm into this node. */}
              <span className="app-tree-guides" aria-hidden="true">
                {Array.from({ length: node.depth }, (_, level) => (
                  <span key={level} className="app-tree-guide" />
                ))}
                <span className={`app-tree-arm${node.isBranch ? " is-branch" : ""}`} />
              </span>
              <span className={`app-tree-role role-${node.role}`}>
                {roleTag(node.role) || node.role}
              </span>
              <span className="app-tree-text">{node.text ?? node.label}</span>
              <span className="app-tree-time">{relativeTime(node.timestamp)}</span>
              {node.isCurrent ? <span className="app-tree-current">current</span> : null}
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

/** The web /settings port: pi's settings surface, read and written through
 * the pi_api facade (SettingsManager). One row per setting, each edited with
 * a control matched to its kind — a toggle, a select chip row, or a text
 * field — and committed through pi's own setter. */
export function SettingsDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<PiSettingEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
    if (sessionId === null) {
      setError("no session selected");
      return;
    }
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "settings.read", params: {} }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { settings?: PiSettingEntry[] } };
        if (!res.ok || body.ok !== true || body.result?.settings === undefined) {
          throw new Error("settings unavailable");
        }
        setEntries(body.result.settings);
      })
      .catch(() => setError("settings could not be read — is the server reachable?"));
  }, [sessionId]);

  const results = useMemo(() => {
    if (entries === null) return [] as PiSettingEntry[];
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? entries
      : entries.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.key.toLowerCase().includes(needle));
  }, [entries, query]);

  const write = (key: string, value: string | number | boolean | null): void => {
    if (sessionId === null) return;
    setSaving(key);
    setError(null);
    const previous = entries;
    // Optimistic: flip the displayed value now, revert on failure.
    setEntries((prev) => prev?.map((entry) => (entry.key === key ? { ...entry, value } : entry)) ?? prev);
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "settings.write", params: { key, value } }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { key?: string; value?: PiSettingEntry["value"] } };
        if (!res.ok || body.ok !== true) {
          throw new Error(body.error ?? "write rejected");
        }
        const confirmed = body.result?.value;
        if (confirmed !== undefined) {
          setEntries((prev) => prev?.map((entry) => (entry.key === key ? { ...entry, value: confirmed } : entry)) ?? prev);
        }
      })
      .catch((err: unknown) => {
        setEntries(previous);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSaving(null));
  };

  if (error !== null && entries === null) {
    return (
      <DialogFrame title="Settings" onClose={onClose} footer={<span className="app-dialog-hint">esc close</span>}>
        <div className="app-dialog-error" role="alert">{error}</div>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame
      title="Settings"
      onClose={onClose}
      wide
      footer={<span className="app-dialog-hint">{entries === null ? "reading…" : `${results.length}/${entries.length} · changes save immediately · esc close`}</span>}
    >
      {error !== null ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      <input
        ref={searchRef}
        className="app-dialog-search"
        type="text"
        placeholder="Filter settings…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter settings"
      />
      <div className="app-settings-list" role="list" aria-label="Settings">
        {results.map((entry) => (
          <SettingRow key={entry.key} entry={entry} saving={saving === entry.key} onWrite={write} />
        ))}
        {results.length === 0 ? <div className="app-dialog-empty">no settings match "{query}"</div> : null}
      </div>
    </DialogFrame>
  );
}

function SettingRow({
  entry,
  saving,
  onWrite,
}: {
  entry: PiSettingEntry;
  saving: boolean;
  onWrite: (key: string, value: string | number | boolean | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const commitText = (): void => {
    if (draft !== null) onWrite(entry.key, draft.trim() === "" ? null : draft.trim());
    setDraft(null);
  };

  return (
    <div className="app-setting-row">
      <div className="app-setting-meta">
        <span className="app-setting-label">{entry.label}</span>
        {entry.description !== undefined ? <span className="app-setting-desc">{entry.description}</span> : null}
      </div>
      <div className="app-setting-control">
        {entry.kind === "toggle" ? (
          <button
            type="button"
            className={`app-toggle${entry.value === true ? " is-on" : ""}`}
            aria-pressed={entry.value === true}
            disabled={saving}
            onClick={() => onWrite(entry.key, entry.value !== true)}
          >
            <span className="app-toggle-knob" />
            <span className="app-toggle-text">{entry.value === true ? "on" : "off"}</span>
          </button>
        ) : entry.kind === "select" ? (
          <div className="app-setting-options" role="radiogroup" aria-label={entry.label}>
            {(entry.options ?? []).map((option) => {
              const selected = option.value === entry.value;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={saving}
                  className={`app-setting-option${selected ? " is-selected" : ""}`}
                  onClick={() => onWrite(entry.key, option.value)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        ) : (
          <input
            className="app-setting-input"
            type="text"
            value={draft ?? (entry.value === null ? "" : String(entry.value))}
            disabled={saving}
            placeholder={entry.kind === "model" ? "provider/model" : ""}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitText();
              }
              if (event.key === "Escape") {
                setDraft(null);
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The web /scoped-models port: which models Ctrl+P (and the TUI cycle) may
 * pick, persisted as pi's enabledModels patterns through its own setter. null
 * = unscoped (every available model); a list = the selected provider/id set. */
export function ScopedModelsDialog({
  sessionId,
  models,
  current,
  onClose,
}: {
  sessionId: string | null;
  models: ModelRefLike[];
  current?: ModelRefLike;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (sessionId === null) {
      setError("no session selected");
      return;
    }
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "settings.models.read", params: {} }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { enabled?: string[] | null } };
        if (!res.ok || body.ok !== true) throw new Error("scoped models unavailable");
        setEnabled(body.result?.enabled ?? null);
      })
      .catch(() => setError("scoped models could not be read"));
  }, [sessionId]);

  const isSelected = (model: ModelRefLike): boolean => {
    if (enabled === null) return true;
    const full = `${model.provider}/${model.id}`;
    return enabled.includes(full) || enabled.includes(model.id);
  };

  const toggle = (model: ModelRefLike): void => {
    const full = `${model.provider}/${model.id}`;
    if (isSelected(model)) {
      // Deselect: drop this model's concrete id (and a bare-id alias).
      setEnabled((prev) => (prev === null ? models.filter((m) => `${m.provider}/${m.id}` !== full).map((m) => `${m.provider}/${m.id}`) : prev.filter((pattern) => pattern !== full && pattern !== model.id)));
    } else {
      setEnabled((prev) => [...(prev ?? []), full]);
    }
    setError(null);
  };

  const save = (): void => {
    if (sessionId === null) return;
    setSaving(true);
    setError(null);
    // All available models selected → clear scoping (pi's unscoped default).
    const allSelected = enabled === null || models.every((m) => isSelected(m));
    const patterns = allSelected ? null : (enabled ?? models.map((m) => `${m.provider}/${m.id}`));
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "settings.models.write", params: { patterns } }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { enabled?: string[] | null } };
        if (!res.ok || body.ok !== true) throw new Error(body.error ?? "save rejected");
        setEnabled(body.result?.enabled ?? null);
        onClose();
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <DialogFrame
      title="Scoped models"
      onClose={onClose}
      wide
      footer={
        <span className="app-dialog-hint">
          select which models Ctrl+P cycles · click a row to toggle · then save
        </span>
      }
    >
      {error !== null ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      <div className="app-scoped-list" role="list" aria-label="Scoped models">
        {models.length === 0
          ? <div className="app-dialog-empty">no models available</div>
          : models.map((model) => {
            const selected = isSelected(model);
            return (
              <button
                key={`${model.provider}/${model.id}`}
                type="button"
                className={`app-scoped-row${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                onClick={() => toggle(model)}
              >
                <span className="app-scoped-check" aria-hidden="true">{selected ? <Check size={13} weight="bold" /> : null}</span>
                <span className="app-dialog-item-provider">{model.provider}</span>
                <span className="app-dialog-item-id">{model.id}</span>
                {current !== undefined && model.provider === current.provider && model.id === current.id
                  ? <span className="app-dialog-item-current">current</span>
                  : null}
              </button>
            );
          })}
      </div>
      <div className="app-dialog-foot app-dialog-actions">
        <button type="button" className="app-dialog-action" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="app-dialog-action app-dialog-action-primary" disabled={saving || models.length === 0} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </DialogFrame>
  );
}

/** The web /trust port: pi's project-trust selector. Reads pi's own trust
 * options (getProjectTrustOptions) and writes the chosen one through pi's
 * ProjectTrustStore — the same decision surface the TUI offers. */
export function TrustDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<PiTrustState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (sessionId === null) {
      setError("no session selected");
      return;
    }
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "trust.read", params: {} }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: PiTrustState };
        if (!res.ok || body.ok !== true || body.result === undefined) throw new Error("trust unavailable");
        setState(body.result);
      })
      .catch(() => setError("trust state could not be read"));
  }, [sessionId]);

  const choose = (label: string): void => {
    if (sessionId === null) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "trust.write", params: { label } }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: { savedDecision?: PiTrustState["savedDecision"] } };
        if (!res.ok || body.ok !== true) throw new Error(body.error ?? "trust write rejected");
        setState((prev) => (prev === null ? prev : { ...prev, savedDecision: body.result?.savedDecision ?? prev.savedDecision }));
        setSaved(label);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <DialogFrame
      title="Project trust"
      onClose={onClose}
      footer={<span className="app-dialog-hint">saved decisions apply on the next session start · esc close</span>}
    >
      {error !== null ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      {state === null ? (
        <div className="app-dialog-empty">reading trust state…</div>
      ) : (
        <>
          <div className="app-trust-meta">
            <span className="app-setting-label">{state.cwd}</span>
            <span className="app-setting-desc">
              Saved decision: {state.savedDecision === null
                ? "none"
                : `${state.savedDecision.decision ? "trusted" : "untrusted"} (${state.savedDecision.path})`}
            </span>
            {saved !== null ? <span className="app-setting-desc">Saved: {saved}</span> : null}
          </div>
          <div className="app-dialog-list" role="listbox" aria-label="Trust options">
            {state.options.map((option) => {
              const isCurrent = option.savedPath !== undefined
                && state.savedDecision !== null
                && state.savedDecision.path === option.savedPath
                && state.savedDecision.decision === option.trusted;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  disabled={saving}
                  className={`app-dialog-item${isCurrent ? " is-current" : ""}`}
                  onClick={() => choose(option.label)}
                >
                  <span className="app-dialog-item-id">{option.label}</span>
                  {isCurrent ? <span className="app-dialog-item-current">current</span> : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </DialogFrame>
  );
}

/** The web /login port: pi's ModelRuntime login flows. The page lists pi's
 * login providers (getProviders, same shape as its /login selector), starts
 * a login, then renders whatever pi's flow emits — an auth URL, a device
 * code, a prompt (text/secret/select) — and posts the answers back. */
export function LoginDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<Array<{ id: string; name: string; authType: "oauth" | "api_key" }> | null>(null);
  const [phase, setPhase] = useState<"pick" | "running">("pick");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [state, setState] = useState<PiAuthLoginState | null>(null);
  const [answer, setAnswer] = useState("");
  const [events, setEvents] = useState<Array<{ type: string; message?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const api = (body: unknown): Promise<{ ok?: boolean; error?: string; result?: unknown }> => {
    if (sessionId === null) return Promise.resolve({ ok: false, error: "no session selected" });
    return fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json().catch(() => ({})));
  };

  useEffect(() => {
    void (async () => {
      if (sessionId === null) {
        setError("no session selected");
        return;
      }
      const body = await api({ api: "auth.read", params: {} });
      if (body.ok !== true || !Array.isArray((body.result as { providers?: unknown })?.providers)) {
        setError("login providers could not be read");
        return;
      }
      setProviders((body.result as { providers: Array<{ id: string; name: string; authType: "oauth" | "api_key" }> }).providers);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const start = async (providerId: string, authType: "oauth" | "api_key"): Promise<void> => {
    setError(null);
    setEvents([]);
    setState(null);
    setAnswer("");
    const body = await api({ api: "auth.login", params: { providerId, authType } });
    if (body.ok !== true) {
      setError(body.error ?? "login could not be started");
      return;
    }
    const id = (body.result as { loginId: string }).loginId;
    setLoginId(id);
    setPhase("running");
  };

  // Poll the pending login; render each outstanding prompt / notify event.
  useEffect(() => {
    if (loginId === null || phase !== "running") return;
    let cancelled = false;
    const poll = (): void => {
      void api({ api: "auth.state", params: { loginId } }).then((body) => {
        if (cancelled) return;
        if (body.ok !== true) {
          setError(body.error ?? "login state unavailable");
          return;
        }
        const next = body.result as PiAuthLoginState;
        setState(next);
        const event = next.event;
        if (event !== undefined && event !== null && event.message !== undefined) {
          setEvents((prev) => {
            const last = prev[prev.length - 1];
            if (last !== undefined && last.type === event.type && last.message === event.message) return prev;
            return [...prev, { type: event.type, message: event.message }];
          });
        }
        if (next.status === "pending") setTimeout(poll, 400);
        else if (next.status === "done") {
          // The credential is stored; stay on a success screen.
        }
      });
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginId, phase]);

  const submit = async (): Promise<void> => {
    if (loginId === null) return;
    const body = await api({ api: "auth.answer", params: { loginId, value: answer } });
    if (body.ok !== true) {
      setError(body.error ?? "answer rejected");
      return;
    }
    setAnswer("");
  };

  const promptBlock = state?.prompt;
  const eventBlock = state?.event;

  return (
    <DialogFrame
      title="Login"
      onClose={onClose}
      wide
      footer={<span className="app-dialog-hint">esc close · login runs against pi's own credential store</span>}
    >
      {error !== null ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      {phase === "pick" ? (
        providers === null ? (
          <div className="app-dialog-empty">reading login providers…</div>
        ) : providers.length === 0 ? (
          <div className="app-dialog-empty">no login providers available</div>
        ) : (
          <div className="app-dialog-list" role="listbox" aria-label="Login providers">
            {providers.map((provider) => (
              <button
                key={`${provider.id}:${provider.authType}`}
                type="button"
                role="option"
                className="app-dialog-item"
                onClick={() => void start(provider.id, provider.authType)}
              >
                <span className="app-dialog-item-id">{provider.name}</span>
                <span className="app-dialog-item-provider">{provider.authType === "oauth" ? "account" : "api key"}</span>
              </button>
            ))}
          </div>
        )
      ) : state === null ? (
        <div className="app-dialog-empty">starting login…</div>
      ) : state.status === "done" ? (
        <div className="app-dialog-empty">Logged in. You can close this dialog.</div>
      ) : state.status === "error" ? (
        <div className="app-dialog-error" role="alert">{state.error ?? "login failed"}</div>
      ) : (
        <div className="app-auth-flow">
          {/* Outstanding prompt: text/secret input, or a select. */}
          {promptBlock !== undefined && promptBlock !== null ? (
            <div className="app-auth-prompt">
              <span className="app-setting-label">{promptBlock.message}</span>
              {promptBlock.options !== undefined ? (
                <div className="app-dialog-list" role="listbox" aria-label={promptBlock.message}>
                  {promptBlock.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="app-dialog-item"
                      onClick={() => {
                        setAnswer(option.id);
                        void (async () => {
                          if (loginId === null) return;
                          const body = await api({ api: "auth.answer", params: { loginId, value: option.id } });
                          if (body.ok !== true) setError(body.error ?? "answer rejected");
                        })();
                      }}
                    >
                      <span className="app-dialog-item-id">{option.label}</span>
                      {option.description !== undefined ? <span className="app-dialog-item-provider">{option.description}</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="app-auth-answer">
                  <input
                    type={promptBlock.type === "secret" ? "password" : "text"}
                    className="app-setting-input"
                    value={answer}
                    placeholder={promptBlock.placeholder ?? ""}
                    onChange={(event) => setAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submit();
                    }}
                    autoFocus
                  />
                  <button type="button" className="app-dialog-action app-dialog-action-primary" onClick={() => void submit()}>
                    Continue
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {/* An auth URL or device code pi's flow emitted. */}
          {eventBlock?.type === "auth_url" ? (
            <div className="app-auth-event">
              <span className="app-setting-label">Visit the link to sign in</span>
              <a className="app-auth-link" href={eventBlock.url} target="_blank" rel="noreferrer">
                {eventBlock.url}
              </a>
            </div>
          ) : eventBlock?.type === "device_code" ? (
            <div className="app-auth-event">
              <span className="app-setting-label">Enter this code at {eventBlock.verificationUri}</span>
              <span className="app-auth-code">{eventBlock.userCode}</span>
              {eventBlock.verificationUri !== undefined ? (
                <a className="app-auth-link" href={eventBlock.verificationUri} target="_blank" rel="noreferrer">
                  {eventBlock.verificationUri}
                </a>
              ) : null}
            </div>
          ) : null}
          {/* Rolling status lines (info/progress). */}
          {events.length > 0 ? (
            <pre className="app-dialog-lines">{events.map((line) => line.message ?? "").join("\n")}</pre>
          ) : null}
        </div>
      )}
    </DialogFrame>
  );
}

/** The web /logout port: pi's stored credentials (listCredentials), removed
 * through pi's ModelRuntime.logout — the same file the TUI's /logout clears. */
export function LogoutDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [credentials, setCredentials] = useState<Array<{ providerId: string; type: "oauth" | "api_key" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (): void => {
    if (sessionId === null) return;
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "auth.read", params: {} }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { credentials?: Array<{ providerId: string; type: "oauth" | "api_key" }> } };
        if (!res.ok || body.ok !== true) throw new Error("credentials unavailable");
        setCredentials(body.result?.credentials ?? []);
      })
      .catch(() => setError("stored credentials could not be read"));
  };

  useEffect(load, [sessionId]);

  const logout = (providerId: string): void => {
    if (sessionId === null) return;
    setBusy(providerId);
    setError(null);
    fetch(`/api/agent/${encodeURIComponent(sessionId)}/pi_api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api: "auth.logout", params: { providerId } }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || body.ok !== true) throw new Error(body.error ?? "logout rejected");
        setCredentials((prev) => prev?.filter((credential) => credential.providerId !== providerId) ?? prev);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  return (
    <DialogFrame
      title="Logout"
      onClose={onClose}
      footer={<span className="app-dialog-hint">removes credentials saved by /login · env vars and models.json are unchanged</span>}
    >
      {error !== null ? <div className="app-dialog-error" role="alert">{error}</div> : null}
      {credentials === null ? (
        <div className="app-dialog-empty">reading credentials…</div>
      ) : credentials.length === 0 ? (
        <div className="app-dialog-empty">no stored credentials to remove</div>
      ) : (
        <div className="app-dialog-list" role="listbox" aria-label="Stored credentials">
          {credentials.map((credential) => (
            <button
              key={credential.providerId}
              type="button"
              role="option"
              disabled={busy === credential.providerId}
              className="app-dialog-item"
              onClick={() => logout(credential.providerId)}
            >
              <span className="app-dialog-item-id">{credential.providerId}</span>
              <span className="app-dialog-item-provider">{credential.type === "oauth" ? "account" : "api key"}</span>
              {busy === credential.providerId ? <span className="app-dialog-item-current">removing…</span> : null}
            </button>
          ))}
        </div>
      )}
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
                    <X size={14} />
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
