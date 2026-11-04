import React from "react";
import type { WebView, KvWebView, ListWebView, StatusWebView } from "@/lib/web-plugins-host";

interface PluginViewRendererProps {
  view: WebView | null | undefined;
}

export function PluginViewRenderer({ view }: PluginViewRendererProps) {
  if (!view) {
    return (
      <div className="plugin-empty-state" data-testid="plugin-empty-state">
        <p>No view published yet</p>
      </div>
    );
  }

  if (view.type === "kv") {
    return <KvViewRenderer view={view} />;
  }

  if (view.type === "list") {
    return <ListViewRenderer view={view} />;
  }

  if (view.type === "status") {
    return <StatusViewRenderer view={view} />;
  }

  return (
    <div className="plugin-unknown-view">
      <p>Unknown view format</p>
    </div>
  );
}

function KvViewRenderer({ view }: { view: KvWebView }) {
  return (
    <div className="plugin-view plugin-view-kv" data-testid="plugin-view-kv">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <table className="plugin-kv-table">
        <tbody>
          {view.rows.map((row: { label: string; value: string }, index: number) => (
            <tr key={index} className="plugin-kv-row">
              <td className="plugin-kv-label">{row.label}</td>
              <td className="plugin-kv-value">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Boolean(view.omitted && view.omitted > 0) && (
        <div className="plugin-view-omitted">… {view.omitted} rows omitted</div>
      )}
    </div>
  );
}

function ListViewRenderer({ view }: { view: ListWebView }) {
  return (
    <div className="plugin-view plugin-view-list" data-testid="plugin-view-list">
      {view.title && <h3 className="plugin-view-title">{view.title}</h3>}
      <ul className="plugin-list">
        {view.items.map((item: string, index: number) => (
          <li key={index} className="plugin-list-item">
            {item}
          </li>
        ))}
      </ul>
      {Boolean(view.omitted && view.omitted > 0) && (
        <div className="plugin-view-omitted">… {view.omitted} items omitted</div>
      )}
    </div>
  );
}

function StatusViewRenderer({ view }: { view: StatusWebView }) {
  return (
    <div
      className={`plugin-view plugin-view-status tone-${view.tone}`}
      data-testid="plugin-view-status"
    >
      <span className="plugin-status-badge">{view.tone}</span>
      <span className="plugin-status-text">{view.text}</span>
    </div>
  );
}
