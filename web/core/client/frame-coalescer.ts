// Run a render at most once per animation frame, however many updates arrive
// in between.
//
// Stream deltas arrive as separate SSE messages, one per token. Each one used
// to schedule its own React render, so the transcript re-rendered faster than
// the screen could paint. `request` coalesces them into one render per frame;
// `flush` renders now, for updates that must show at once (a run ending, a
// message committing), and drops any frame still waiting.
//
// The frame source is injected so the policy can be tested without a DOM.

export interface FrameSource<Handle> {
  request(callback: () => void): Handle;
  cancel(handle: Handle): void;
}

export interface FrameCoalescer {
  /** Render on the next frame; a render already waiting absorbs this one. */
  request(): void;
  /** Render now and drop the frame still waiting, if any. */
  flush(): void;
  /** Drop the frame still waiting without rendering, e.g. on unmount. */
  dispose(): void;
}

export function createFrameCoalescer<Handle>(
  render: () => void,
  source: FrameSource<Handle>,
): FrameCoalescer {
  // The handle of the frame still waiting. A cancelled frame never runs its
  // callback, so a callback that does run always belongs to the live frame.
  let pending: { handle: Handle } | null = null;

  const dropPending = (): void => {
    if (pending === null) return;
    source.cancel(pending.handle);
    pending = null;
  };

  return {
    request() {
      if (pending !== null) return;
      let ran = false;
      const handle = source.request(() => {
        ran = true;
        pending = null;
        render();
      });
      // A frame source may run the callback before it returns; then nothing waits.
      if (!ran) pending = { handle };
    },
    flush() {
      dropPending();
      render();
    },
    dispose() {
      dropPending();
    },
  };
}
