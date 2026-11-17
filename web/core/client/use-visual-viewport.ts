import { useEffect } from "react";

/** Safari's keyboard resizes/pans the visual viewport without changing 100dvh.
 * Follow that frame, but don't reflow the app when the user pinch-zooms. */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const root = document.documentElement;
    const sync = (): void => {
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
      root.dataset.viewportShort = viewport.height <= 300 ? "true" : "false";
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
      delete root.dataset.viewportShort;
    };
  }, []);
}
