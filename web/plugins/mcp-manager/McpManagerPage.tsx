// The MCP manager page: pi's own MCP configuration, read and written through
// the pi_api facade (mcp.read / mcp.write). The page renders the merged
// server list pi's /mcp shows — global and (when trusted) project entries —
// and every edit goes through pi's config mutators, never a hand-edited
// mcp.json. Config is workspace state, not session state: the page needs a
// selected session only to resolve the working directory pi reads.

import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import type { PiMcpConfigState, PiMcpServerEntry, PiMcpWriteParams } from "../../core/shared/pi-api.ts";
import { fetchMcpState, writeMcpConfig, type McpResult } from "./lib/mcp-client.ts";

interface McpManagerPageProps {
  sessionId: string | null;
}

/** The add/edit form's editable snapshot of one server entry. */
interface ServerFormState {
  /** Null when adding; the edited entry's name before any rename. */
  originalName: string | null;
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  url: string;
  headersText: string;
  envText: string;
  description: string;
  scope: "global" | "project";
}

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

export function McpManagerPage({ sessionId }: McpManagerPageProps) {
  const [state, setState] = useState<PiMcpConfigState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ServerFormState | null>(null);

  const refresh = useCallback(async () => {
    if (sessionId === null) {
      setState(null);
      setError("Select a session to manage the MCP servers of its workspace.");
      return;
    }
    setBusy(true);
    const outcome = await fetchMcpState(sessionId);
    setBusy(false);
    settleOutcome(outcome, setState, setError);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(async (params: PiMcpWriteParams) => {
    if (sessionId === null) return;
    setBusy(true);
    const outcome = await writeMcpConfig(sessionId, params);
    setBusy(false);
    settleOutcome(outcome, setState, setError);
  }, [sessionId]);

  if (sessionId === null) {
    return <p className="mcp-empty">Select a session to manage the MCP servers of its workspace.</p>;
  }
  if (state === null) {
    return <p className="mcp-empty">{error ?? "Loading MCP configuration…"}</p>;
  }

  return (
    <div className="mcp-manager">
      {error !== null ? <p className="mcp-error" role="alert">{error}</p> : null}
      <McpConfigHeader state={state} />
      <p className="mcp-hint">Changes land in pi's own mcp.json files. A running session applies them on <code>/reload</code> or <code>/mcp-manager-reload</code>; a new session applies them on start.</p>
      <div className="mcp-toolbar">
        <button
          type="button"
          className="mcp-add-button"
          disabled={busy}
          onClick={() => setForm(newFormState())}
        >
          <Plus size={14} /> Add server
        </button>
        {busy ? <span className="mcp-busy">working…</span> : null}
      </div>
      {form !== null ? (
        <ServerForm
          form={form}
          busy={busy}
          projectAvailable={state.projectConfigPath !== null}
          onChange={setForm}
          onClose={() => setForm(null)}
          onSave={(next) => {
            setForm(null);
            void apply(next);
          }}
        />
      ) : null}
      {state.servers.length === 0
        ? <p className="mcp-empty">No MCP servers configured. Add one, or run <code>pi mcp add</code>.</p>
        : (
          <ul className="mcp-server-list">
            {state.servers.map((entry) => (
              <ServerCard
                key={`${entry.source}:${entry.name}`}
                entry={entry}
                state={state}
                busy={busy}
                onApply={apply}
                onEdit={() => setForm(editFormState(entry, state))}
                onRemoveOverride={
                  entry.override !== undefined
                    ? () => void apply({ action: "remove", scope: "project", name: entry.name })
                    : undefined
                }
              />
            ))}
          </ul>
        )}
    </div>
  );
}

/** Land a pi_api result: state in, or the failure message visible. */
function settleOutcome(
  outcome: McpResult<PiMcpConfigState>,
  setState: (state: PiMcpConfigState) => void,
  setError: (message: string | null) => void,
): void {
  if (outcome.ok) {
    setState(outcome.data);
    setError(null);
  } else {
    setError(outcome.message);
  }
}

function McpConfigHeader({ state }: { state: PiMcpConfigState }) {
  return (
    <div className="mcp-header">
      <p className="mcp-path">user: <code>{state.globalConfigPath}</code></p>
      {state.projectConfigPath !== null
        ? <p className="mcp-path">project: <code>{state.projectConfigPath}</code></p>
        : <p className="mcp-path mcp-path-muted">project config unavailable — trust this workspace to add project servers</p>}
      {state.errors.length > 0 ? (
        <ul className="mcp-errors" role="alert">
          {state.errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

interface ServerCardProps {
  entry: PiMcpServerEntry;
  state: PiMcpConfigState;
  busy: boolean;
  onApply: (params: PiMcpWriteParams) => Promise<void>;
  onEdit: () => void;
  onRemoveOverride?: () => void;
}

function ServerCard({ entry, state, busy, onApply, onEdit, onRemoveOverride }: ServerCardProps) {
  const scopeLabel = entry.scope === "extension" ? "extension" : entry.scope === "project" ? "project" : "user";

  return (
    <li className="mcp-server">
      <div className="mcp-server-head">
        <span className={`mcp-server-name${entry.enabled ? "" : " mcp-server-disabled"}`}>{entry.name}</span>
        <span className="mcp-chip">{entry.transport}</span>
        <span className="mcp-chip">{scopeLabel}</span>
        <span className={`mcp-chip${entry.enabled ? "" : " mcp-chip-off"}`}>{entry.enabled ? "enabled" : "disabled"}</span>
      </div>
      <p className="mcp-server-detail">
        {entry.transport === "stdio"
          ? <code>{entry.command} {(entry.args ?? []).join(" ")}</code>
          : <code>{entry.url}</code>}
      </p>
      {entry.description ? <p className="mcp-server-desc">{entry.description}</p> : null}
      {entry.override !== undefined ? (
        <p className="mcp-server-desc">project override in <code>{entry.override}</code></p>
      ) : null}
      <div className="mcp-server-controls">
        <label className="mcp-toggle">
          <input
            type="checkbox"
            checked={entry.enabled}
            disabled={busy}
            onChange={(event) =>
              void onApply({ action: "patch", name: entry.name, enabled: event.target.checked })}
          />
          enabled
        </label>
        <label className="mcp-exposure">
          exposure{" "}
          <select
            value={entry.exposure}
            disabled={busy}
            onChange={(event) =>
              void onApply({ action: "patch", name: entry.name, exposure: event.target.value })}
          >
            {EXPOSURES.map((exposure) => <option key={exposure} value={exposure}>{exposure}</option>)}
          </select>
        </label>
        {entry.scope === "global" && state.projectTrusted ? (
          <button
            type="button"
            className="mcp-small-button"
            disabled={busy}
            onClick={() => void onApply({ action: "override", name: entry.name, enabled: false })}
          >
            Disable in this project
          </button>
        ) : null}
        <button type="button" className="mcp-small-button" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="mcp-small-button mcp-small-button-danger"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Remove ${entry.name} from ${entry.source}?`)) return;
            void onApply({
              action: "remove",
              scope: entry.source === state.globalConfigPath ? "global" : "project",
              name: entry.name,
            });
          }}
        >
          <Trash size={12} /> Remove
        </button>
        {onRemoveOverride !== undefined ? (
          <button type="button" className="mcp-small-button" disabled={busy} onClick={onRemoveOverride}>
            Remove project override
          </button>
        ) : null}
      </div>
    </li>
  );
}

interface ServerFormProps {
  form: ServerFormState;
  busy: boolean;
  projectAvailable: boolean;
  onChange: (form: ServerFormState) => void;
  onClose: () => void;
  onSave: (params: PiMcpWriteParams) => void;
}

function ServerForm({ form, busy, projectAvailable, onChange, onClose, onSave }: ServerFormProps) {
  const set = (patch: Partial<ServerFormState>): void => onChange({ ...form, ...patch });
  const nameValid = /^[A-Za-z0-9_-]+$/.test(form.name);
  const stdioReady = form.transport === "http" || form.command.trim() !== "";

  return (
    <form
      className="mcp-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!nameValid || !stdioReady) return;
        onSave({ action: "add", scope: form.scope, name: form.name, config: buildServerConfig(form) });
      }}
    >
      <h3 className="mcp-form-title">{form.originalName === null ? "Add server" : `Edit ${form.originalName}`}</h3>
      <div className="mcp-form-grid">
        <label>Name
          <input value={form.name} onChange={(event) => set({ name: event.target.value })} autoFocus />
        </label>
        <label>Kind
          <select
            value={form.transport}
            onChange={(event) => set({ transport: event.target.value as "stdio" | "http" })}
          >
            <option value="stdio">stdio (local command)</option>
            <option value="http">HTTP (remote URL)</option>
          </select>
        </label>
        {form.transport === "stdio" ? (
          <>
            <label>Command
              <input
                value={form.command}
                placeholder="npx"
                onChange={(event) => set({ command: event.target.value })}
              />
            </label>
            <label>Arguments (one per line)
              <textarea
                value={form.argsText}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
                onChange={(event) => set({ argsText: event.target.value })}
              />
            </label>
            <label>Environment (KEY=value, one per line)
              <textarea
                value={form.envText}
                placeholder={"API_KEY=${API_KEY}"}
                onChange={(event) => set({ envText: event.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <label>URL
              <input
                value={form.url}
                placeholder="https://example.com/mcp"
                onChange={(event) => set({ url: event.target.value })}
              />
            </label>
            <label>Headers (Key: value, one per line)
              <textarea
                value={form.headersText}
                placeholder={"Authorization: Bearer ${TOKEN}"}
                onChange={(event) => set({ headersText: event.target.value })}
              />
            </label>
          </>
        )}
        <label>Description (one line, shown to the model)
          <input
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
          />
        </label>
        <label>Saves to
          <select
            value={form.scope}
            disabled={!projectAvailable}
            onChange={(event) => set({ scope: event.target.value as "global" | "project" })}
          >
            <option value="global">user mcp.json</option>
            <option value="project">project .pi/mcp.json</option>
          </select>
        </label>
      </div>
      {!projectAvailable ? <p className="mcp-form-hint">Project saving needs a trusted workspace.</p> : null}
      <div className="mcp-form-actions">
        <button type="submit" className="mcp-add-button" disabled={busy || !nameValid || !stdioReady}>
          Save
        </button>
        <button type="button" className="mcp-small-button" onClick={onClose}>Cancel</button>
        {!nameValid ? <span className="mcp-form-hint">name: letters, digits, _ and - only</span> : null}
      </div>
    </form>
  );
}

/** A blank form for a new server, defaulting to the user file. */
function newFormState(): ServerFormState {
  return {
    originalName: null,
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    url: "",
    headersText: "",
    envText: "",
    description: "",
    scope: "global",
  };
}

/** A form prefilled from a live entry, so an edit round-trips every field. */
function editFormState(entry: PiMcpServerEntry, state: PiMcpConfigState): ServerFormState {
  return {
    originalName: entry.name,
    name: entry.name,
    transport: entry.transport,
    command: entry.command ?? "",
    argsText: (entry.args ?? []).join("\n"),
    url: entry.url ?? "",
    headersText: serializeKeyValue(entry.headers),
    envText: serializeKeyValue(entry.env),
    description: entry.description ?? "",
    scope: entry.source === state.globalConfigPath ? "global" : "project",
  };
}

/** pi validates the entry; the form's job is only a faithful wire shape. */
function buildServerConfig(form: ServerFormState): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (form.transport === "stdio") {
    config.command = form.command.trim();
    config.args = form.argsText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const env = parseKeyValueLines(form.envText);
    if (env !== null) config.env = env;
  } else {
    config.url = form.url.trim();
    const headers = parseKeyValueLines(form.headersText);
    if (headers !== null) config.headers = headers;
  }
  if (form.description.trim() !== "") config.description = form.description.trim();
  return config;
}

/** "KEY=value" lines into a record; null for blank or malformed input. */
function parseKeyValueLines(text: string): Record<string, string> | null {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return null;
  const record: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) return null;
    record[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return record;
}

/** The inverse of parseKeyValueLines, for the edit form. */
function serializeKeyValue(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {}).map(([key, value]) => `${key}=${value}`).join("\n");
}
