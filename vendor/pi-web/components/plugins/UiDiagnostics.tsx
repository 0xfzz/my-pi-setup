"use client";

import { useState } from "react";
import { WEB_UI_COMPONENTS, normalizeContributions, resolveOverrides } from "@/lib/web-ui-contracts";
import { getUiDiagnostics, useWebUiState } from "@/hooks/useWebUiState";
import { getDisabledUiContributions } from "./UiComponent";
import "./plugins.css";

export function UiDiagnostics() {
  const data = useWebUiState();
  const [selection, setSelection] = useState("");
  const sessionIds = Object.keys(data.ui?.sessions ?? {}).sort();
  const sessionId = sessionIds.includes(selection) ? selection : sessionIds[0] ?? "";
  const session = data.ui?.sessions[sessionId];
  const running = data.sessions[sessionId]?.running ?? session?.running ?? false;
  const declared = data.plugins.flatMap(plugin => normalizeContributions(plugin).map(contribution => ({ pluginId: plugin.id, contribution })));
  const active = declared.filter(({ pluginId, contribution: c }) => {
    if (!session || session.closed) return false;
    return !(c.visibleWhen === "running" && !running)
      && !(c.visibleWhen === "idle" && running)
      && !(c.visibleWhen === "has-view" && !data.views[sessionId]?.[c.view ?? pluginId]);
  });
  const disabled = new Set(getDisabledUiContributions(sessionId));
  const local = getUiDiagnostics();
  return <div className="plugin-page-container">
    <header className="plugin-page-header"><a className="plugin-nav-home-link" href="/">← Pi Web</a></header>
    <main className="plugin-page-main">
      <h1 className="plugin-page-title">Plugin UI diagnostics</h1>
      <p>Read-only developer view. Renderer health belongs to this browser tab; rejected events belong to the host.</p>
      {data.loading ? <p role="status">Loading UI snapshot…</p> : <>
        <dl aria-label="UI stream metrics" className="plugin-kv-table">
          <dt>Epoch</dt><dd>{data.ui?.epoch ?? "Unavailable"}</dd>
          <dt>Revision</dt><dd>{data.ui?.revision ?? 0}</dd>
          {Object.entries(data.ui?.metrics ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
          <dt>Declared contributions</dt><dd>{declared.length}</dd>
          <dt>Eligible contributions in selected session</dt><dd>{active.length}</dd>
          <dt>Disabled renderers in selected session</dt><dd>{disabled.size}</dd>
        </dl>
        <label>Session <select value={sessionId} onChange={event => setSelection(event.target.value)}>
          {sessionIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>
        <h2>Override resolution and circuit breakers</h2>
        <table className="plugin-kv-table"><thead><tr><th>Component</th><th>Renderer</th><th>Wrappers, outermost first</th></tr></thead>
          <tbody>{Object.keys(WEB_UI_COMPONENTS).map(key => {
            const resolution = resolveOverrides(key as keyof typeof WEB_UI_COMPONENTS, active, disabled);
            return <tr key={key}><td>{key}</td><td>{resolution.hidden ? "hidden" : resolution.replacement ? `${resolution.replacement.pluginId}/${resolution.replacement.contribution.id}` : "builtin"}</td>
              <td>{resolution.wrappers.map(owner => `${owner.pluginId}/${owner.contribution.id}`).join(" → ") || "None"}</td></tr>;
          })}</tbody>
        </table>
        {disabled.size > 0 && <ul aria-label="Disabled renderers">{[...disabled].map(owner => <li key={owner}>{owner}: disabled for this session, builtin fallback</li>)}</ul>}
        <h2>Rejected host events and placement conflicts</h2>
        {data.ui?.diagnostics.length ? <ul aria-label="Host UI diagnostics">{data.ui.diagnostics.map((entry, index) => <li key={index}>
          <time>{new Date(entry.timestamp).toISOString()}</time> {entry.sessionId} / {entry.sourceKey}: {entry.message}
        </li>)}</ul> : <p>No rejected host events.</p>}
        <h2>Browser validation and renderer failures</h2>
        {local.length ? <ul aria-label="Browser UI diagnostics">{local.map((message, index) => <li key={index}>{message}</li>)}</ul> : <p>No browser UI failures in this tab.</p>}
      </>}
    </main>
  </div>;
}
