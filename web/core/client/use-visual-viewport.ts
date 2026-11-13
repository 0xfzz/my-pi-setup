import { useEffect } from "react";

/** Safari's keyboard resizes/pans the visual viewport without changing 100dvh.
 * Follow that frame, but don't reflow the app when the user pinch-zooms. */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const style = document.documentElement.style;
    const sync = (): void => {
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      style.setProperty("--app-viewport-height", `${viewport.height}px`);
      style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      style.removeProperty("--app-viewport-height");
      style.removeProperty("--app-viewport-top");
    };
  }, []);
}
