// Base shell: the three minimal pi regions (header, transcript, composer).
// Phase A renders the empty state; Phase B wires the session, and later
// phases add plugin slots and override surfaces around these regions.

export function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">pi</span>
        <span className="app-subtitle">minimal web client</span>
        <span className="app-header-status">no session</span>
      </header>
      <main className="app-transcript" aria-live="polite">
        <div className="app-empty">No session selected.</div>
      </main>
      <footer className="app-composer">
        <textarea
          className="app-composer-input"
          placeholder="Message pi…"
          disabled
          aria-label="Message pi"
        />
      </footer>
    </div>
  );
}
