import React from "react";
import type { WebView } from "@/lib/web-ui-views";
export { useWebUiState as usePluginData } from "@/hooks/useWebUiState";
export type { PluginSessionState, PluginDataState } from "@/hooks/useWebUiState";

export interface SessionStatusDotProps {
  running?: boolean; awaitingInput?: boolean; sessionId?: string; showLabel?: boolean; className?: string;
}
export function SessionStatusDot({ running, awaitingInput, sessionId, showLabel = false, className = "" }: SessionStatusDotProps) {
  const label = running ? awaitingInput ? "awaiting input" : "running" : "idle";
  const title = sessionId ? `${sessionId} (${label})` : label;
  return <span className={`plugin-status-indicator ${className}`} title={title} aria-label={title}>
    <span className={`plugin-status-dot ${running ? "plugin-status-running" : "plugin-status-idle"}`} data-testid="plugin-status-dot" />
    {showLabel && <span className="plugin-status-label">{label}</span>}
  </span>;
}
export function PluginViewRenderer({ view }: { view: WebView | null | undefined }) {
  if (!view) return <div className="plugin-empty-state" data-testid="plugin-empty-state"><p>No view published yet</p></div>;
  switch (view.type) {
    case "kv": return <div className="plugin-view plugin-view-kv" data-testid="plugin-view-kv">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <table className="plugin-kv-table"><tbody>{view.rows.map((row, index) => <tr key={index} className="plugin-kv-row"><td className="plugin-kv-label">{row.label}</td><td className="plugin-kv-value">{row.value}</td></tr>)}</tbody></table>
      {!!view.omitted && <div className="plugin-view-omitted">… {view.omitted} rows omitted</div>}
    </div>;
    case "list": return <div className="plugin-view plugin-view-list" data-testid="plugin-view-list">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <ul className="plugin-list">{view.items.map((item, index) => <li key={index} className="plugin-list-item">{item}</li>)}</ul>
      {!!view.omitted && <div className="plugin-view-omitted">… {view.omitted} items omitted</div>}
    </div>;
    case "status": return <div className={`plugin-view plugin-view-status tone-${view.tone}`} data-testid="plugin-view-status"><span className="plugin-status-badge">{view.tone}</span><span className="plugin-status-text">{view.text}</span></div>;
    default: return <div className="plugin-unknown-view"><p>Unknown view format</p></div>;
  }
}
