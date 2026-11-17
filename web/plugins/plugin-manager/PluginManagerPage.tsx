// The plugin manager page: the operator surface for the kernel (PRD R21). It
// lists every installed plugin with its lifecycle state, granted/pending
// capabilities and mounted backend routes, and drives enable / disable / reload
// / clear-quarantine / clear-safe-mode through the operator endpoints.
// Read-only rendering — the kernel decides, the page reports.

import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, Plugs, WarningCircle } from "@phosphor-icons/react";
import { KERNEL_MANAGER_ID } from "../../core/shared/plugin-manager.ts";
import {
  applyManagerAction,
  availableActions,
  fetchPluginManagerReport,
  groupBySource,
  safeModeBanner,
  type PluginCapabilityAction,
  type PluginManagerAction,
  type PluginManagerCommand,
  type PluginManagerReport,
  type PluginManagerRow,
} from "./lib/plugin-manager-api.ts";

const ACTION_LABELS: Record<PluginManagerAction, string> = {
  enable: "Enable",
  disable: "Disable",
  reload: "Reload",
  "clear-quarantine": "Clear quarantine",
  "clear-safe-mode": "Leave safe mode",
};

export function PluginManagerPage() {
  const [report, setReport] = useState<PluginManagerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const outcome = await fetchPluginManagerReport();
    if (outcome.ok) {
      setReport(outcome.data);
      setError(null);
    } else {
      setError(outcome.message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (pluginId: string, action: PluginManagerCommand, capability?: string) => {
      setBusy(`${pluginId}:${action}:${capability ?? ""}`);
      const outcome = await applyManagerAction(pluginId, action, capability);
      setBusy(null);
      if (!outcome.ok) setError(outcome.message);
      else if (!outcome.data.ok) setError(`${pluginId}: ${outcome.data.error ?? "action refused"}`);
      else setError(null);
      await refresh();
    },
    [refresh],
  );

  if (report === null) {
    return <p className="plugin-manager-empty">{error ?? "Reading the plugin kernel…"}</p>;
  }

  return (
    <div className="plugin-manager">
      <PluginManagerHeader report={report} busy={busy} onRefresh={() => void refresh()} onLeaveSafeMode={() => void run(KERNEL_MANAGER_ID, "clear-safe-mode")} />
      {error !== null ? <p className="plugin-manager-error" role="alert">{error}</p> : null}
      {groupBySource(report.plugins).map((group) => (
        <section key={group.source} className="plugin-manager-group">
          <h3 className="plugin-manager-group-title">{group.source}</h3>
          <ul className="plugin-manager-list">
            {group.rows.map((row) => (
              <PluginRow
                key={row.id}
                row={row}
                busy={busy}
                onAction={(action, capability) => void run(row.id, action, capability)}
              />
            ))}
          </ul>
        </section>
      ))}
      <AuditTail entries={report.audit} />
    </div>
  );
}

function PluginManagerHeader({
  report,
  busy,
  onRefresh,
  onLeaveSafeMode,
}: {
  report: PluginManagerReport;
  busy: string | null;
  onRefresh: () => void;
  onLeaveSafeMode: () => void;
}) {
  return (
    <div className="plugin-manager-header">
      <p className="plugin-manager-count">
        {report.plugins.length} installed · {report.plugins.filter((row) => row.state === "active").length} active
      </p>
      {safeModeBanner(report).visible ? (
        <p className="plugin-manager-warning" role="status" style={{ flexWrap: "wrap" }}>
          <WarningCircle size={14} aria-hidden="true" /> Safe mode: only <code>core.*</code> plugins start
          automatically, so every other plugin's actions are refused.
          <button
            type="button"
            className="plugin-manager-refresh plugin-manager-action"
            disabled={busy !== null}
            onClick={onLeaveSafeMode}
          >
            {busy === `${KERNEL_MANAGER_ID}:clear-safe-mode:` ? safeModeBanner(report).busyLabel : safeModeBanner(report).label}
          </button>
        </p>
      ) : null}
      {report.warnings.length > 0 ? (
        <ul className="plugin-manager-warnings" role="status">
          {report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
      {report.shadowed.length > 0 ? (
        <p className="plugin-manager-note">
          Shadowed: {report.shadowed.map((entry) => `${entry.id} (${entry.source} → ${entry.shadowedBy})`).join(", ")}
        </p>
      ) : null}
      <button type="button" className="plugin-manager-refresh plugin-manager-action" onClick={onRefresh}>
        <ArrowsClockwise size={13} aria-hidden="true" /> Refresh
      </button>
    </div>
  );
}

function PluginRow({
  row,
  busy,
  onAction,
}: {
  row: PluginManagerRow;
  busy: string | null;
  onAction: (action: PluginManagerCommand, capability?: string) => void;
}) {
  const actions = availableActions(row.state);
  const capabilityBusy = (action: PluginCapabilityAction, capability: string): boolean =>
    busy === `${row.id}:${action}:${capability}`;
  return (
    <li className="plugin-manager-item" data-plugin-id={row.id} data-state={row.state}>
      <div className="plugin-manager-item-head">
        <span className="plugin-manager-item-title">{row.title}</span>
        <span className="plugin-manager-item-id">{row.id}</span>
        <span className={`plugin-manager-chip plugin-manager-chip-${row.state}`}>{row.state}</span>
        <span className="plugin-manager-item-version">v{row.version}</span>
      </div>
      {row.description !== undefined ? <p className="plugin-manager-item-desc">{row.description}</p> : null}
      {row.waiting !== undefined ? <p className="plugin-manager-item-waiting">{row.waiting}</p> : null}
      {row.lastError !== undefined ? (
        <p className="plugin-manager-item-error" role="alert">{row.lastError}</p>
      ) : null}
      {row.quarantine !== undefined ? (
        <p className="plugin-manager-item-error">
          Quarantined at v{row.quarantine.version}: {row.quarantine.reason}
        </p>
      ) : null}
      <div className="plugin-manager-item-meta">
        <CapabilityList label="granted" values={row.grants} />
        {/* A pending capability is a request waiting for the operator: it is
            the only way a sensitive one becomes granted. */}
        <CapabilityList
          label="pending"
          values={row.pending}
          renderAction={(capability) => (
            <button
              type="button"
              className="plugin-manager-grant plugin-manager-action"
              disabled={capabilityBusy("grant", capability)}
              onClick={() => onAction("grant", capability)}
              title={`Grant ${capability}`}
            >
              {capabilityBusy("grant", capability) ? "…" : "Grant"}
            </button>
          )}
        />
        {row.routes.length > 0 ? (
          <span className="plugin-manager-routes">
            <Plugs size={12} aria-hidden="true" />
            {row.routes.map((route) => (
              <code key={`${route.method} ${route.path}`}>
                {route.method} /api/p/{row.id}/{route.path}
              </code>
            ))}
          </span>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="plugin-manager-actions">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={`plugin-manager-action${action === "disable" ? " is-destructive" : ""}`}
              disabled={busy === `${row.id}:${action}:`}
              onClick={() => onAction(action)}
            >
              {busy === `${row.id}:${action}:` ? "…" : ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function CapabilityList({
  label,
  values,
  renderAction,
}: {
  label: string;
  values: readonly string[];
  renderAction?: (capability: string) => React.ReactNode;
}) {
  if (values.length === 0) return null;
  return (
    <span className="plugin-manager-caps">
      {label}:{" "}
      {values.map((value) => (
        <span key={value} className="plugin-manager-cap">
          <code>{value}</code>
          {renderAction?.(value)}
        </span>
      ))}
    </span>
  );
}

function AuditTail({ entries }: { entries: PluginManagerReport["audit"] }) {
  if (entries.length === 0) return null;
  return (
    <details className="plugin-manager-audit">
      <summary className="plugin-manager-summary">Audit log (last {entries.length})</summary>
      <ul>
        {[...entries].reverse().map((entry) => (
          <li key={entry.seq}>
            <span className="plugin-manager-audit-kind">{entry.kind}</span> {entry.pluginId} — {entry.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}
