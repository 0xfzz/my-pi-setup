import React, { useEffect, useState } from "react";
import type {
  WebView,
  KvWebView,
  ListWebView,
  StatusWebView,
  WebPluginDescriptor,
} from "@/lib/web-plugins-host";

export interface PluginSessionState {
  running: boolean;
  awaitingInput?: boolean;
}

export interface PluginDataState {
  plugins: readonly WebPluginDescriptor[];
  views: Record<string, Record<string, WebView>>;
  sessions: Record<string, PluginSessionState>;
  loading: boolean;
}

let sharedState: PluginDataState = {
  plugins: [],
  views: {},
  sessions: {},
  loading: true,
};

const subscribers = new Set<() => void>();
let activeEventSource: EventSource | null = null;
let errorCount = 0;
let fallbackInterval: ReturnType<typeof setInterval> | null = null;
let inFlightFetch: Promise<PluginDataState> | null = null;

async function fetchPluginData(): Promise<PluginDataState> {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async () => {
    try {
      const res = await fetch("/api/plugins", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as {
          plugins?: WebPluginDescriptor[];
          views?: Record<string, Record<string, WebView>>;
          sessions?: Record<string, PluginSessionState>;
        };
        sharedState = {
          plugins: data.plugins ?? [],
          views: data.views ?? {},
          sessions: data.sessions ?? {},
          loading: false,
        };
      }
    } catch (err) {
      console.error("[usePluginData] fetch failed:", err);
    } finally {
      inFlightFetch = null;
      notifySubscribers();
    }
    return sharedState;
  })();
  return inFlightFetch;
}

function notifySubscribers() {
  for (const sub of subscribers) {
    try {
      sub();
    } catch {
      // Best effort
    }
  }
}

function startFallbackPolling() {
  if (fallbackInterval) return;
  fallbackInterval = setInterval(() => {
    void fetchPluginData();
  }, 30_000);
}

function stopFallbackPolling() {
  if (fallbackInterval) {
    clearInterval(fallbackInterval);
    fallbackInterval = null;
  }
}

function setupEventSource() {
  if (typeof window === "undefined") return;
  if (activeEventSource) return;

  try {
    const es = new EventSource("/api/plugins/events");
    activeEventSource = es;

    es.onopen = () => {
      errorCount = 0;
      stopFallbackPolling();
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; revision?: number };
        if (payload && payload.type === "changed") {
          void fetchPluginData();
        }
      } catch {
        // Comment or unparseable event
      }
    };

    es.onerror = () => {
      errorCount++;
      if (errorCount >= 2) {
        startFallbackPolling();
      }
    };
  } catch (err) {
    console.error("[usePluginData] EventSource initialization failed:", err);
    startFallbackPolling();
  }
}

function teardownEventSource() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  stopFallbackPolling();
  errorCount = 0;
}

/**
 * Shared reactive hook for workflow web plugin data.
 * Opens a single EventSource on /api/plugins/events and triggers refetches on change.
 * Falls back to 30s slow polling if EventSource encounters errors.
 */
export function usePluginData(): PluginDataState & { refetch: () => Promise<PluginDataState> } {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onUpdate = () => setTick((t) => t + 1);
    subscribers.add(onUpdate);

    if (subscribers.size === 1) {
      setupEventSource();
      void fetchPluginData();
    }

    return () => {
      subscribers.delete(onUpdate);
      if (subscribers.size === 0) {
        teardownEventSource();
      }
    };
  }, []);

  return {
    ...sharedState,
    refetch: fetchPluginData,
  };
}

export interface SessionStatusDotProps {
  running?: boolean;
  awaitingInput?: boolean;
  sessionId?: string;
  showLabel?: boolean;
  className?: string;
}

export function SessionStatusDot({
  running,
  awaitingInput,
  sessionId,
  showLabel = false,
  className = "",
}: SessionStatusDotProps) {
  const isRunning = Boolean(running);
  const statusClass = isRunning ? "plugin-status-running" : "plugin-status-idle";
  const label = isRunning ? (awaitingInput ? "awaiting input" : "running") : "idle";
  const title = sessionId ? `${sessionId} (${label})` : label;

  return (
    <span
      className={`plugin-status-indicator ${className}`}
      title={title}
      aria-label={title}
    >
      <span className={`plugin-status-dot ${statusClass}`} data-testid="plugin-status-dot" />
      {showLabel && <span className="plugin-status-label">{label}</span>}
    </span>
  );
}

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
