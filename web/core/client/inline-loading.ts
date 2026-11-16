// A component that shows its own in-place loading state (the transcript's
// "Loading conversation…") claims it while that state is on screen. The
// generic request card reads the claim and stays away, so one load never
// shows two spinners: the in-place one says what is loading, so it wins.

export function createInlineLoading() {
  const listeners = new Set<() => void>();
  let claims = 0;
  const publish = () => { for (const listener of listeners) listener(); };

  return {
    /** Register an active in-place loading state; the returned release is idempotent. */
    claim(): () => void {
      claims += 1;
      publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        claims -= 1;
        publish();
      };
    },
    /** True while any in-place loading state is on screen. */
    getSnapshot: (): boolean => claims > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const inlineLoading = createInlineLoading();
