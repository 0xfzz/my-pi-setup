/**
 * close-intent.ts — which child sessions the parent is closing right now.
 *
 * Closing a pane is observable to the watcher that owns the child. If the
 * watcher reports first, the parent's own close is reported as the child
 * "closed before completion (killed externally)" and recorded as a failure. The
 * parent records the intent before the pane is closed, so a report that arrives
 * during the close is recognised as the parent's doing and dropped.
 */
export class CloseIntents {
  private readonly closing = new Set<string>();

  /** Mark a session as being closed by the parent. Call before the pane is closed. */
  begin(sessionFile: string): void {
    this.closing.add(sessionFile);
  }

  /** Clear the mark: the close finished, or it failed and the watcher must count again. */
  end(sessionFile: string): void {
    this.closing.delete(sessionFile);
  }

  /** True while the parent is closing this session. */
  has(sessionFile: string): boolean {
    return this.closing.has(sessionFile);
  }
}
