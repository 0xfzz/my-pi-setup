// Persistent dark/light theme. The choice lives in localStorage; an absent
// choice follows the OS (prefers-color-scheme). applyTheme() runs before the
// first React render so there is no wrong-theme flash, and the toggle just
// flips the stored value.

export type Theme = "dark" | "light";

const THEME_KEY = "pi-web-theme";

export function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Keep the shadcn/Tailwind dark variant in lock-step with the app theme:
  // the Tailwind tokens switch on `.dark`, the legacy stylesheet on
  // `[data-theme]`, and the toggle must move both together.
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function toggleTheme(): Theme {
  const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  const next: Theme = current === "dark" ? "light" : "dark";
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private-mode storage failures just make the toggle non-persistent.
  }
  applyTheme(next);
  return next;
}

/** Call once at startup, before the first paint of app content. */
export function initTheme(): void {
  applyTheme(storedTheme() ?? systemTheme());
  // Follow the OS only while the user has not made an explicit choice.
  const media = window.matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", () => {
    if (storedTheme() === null) applyTheme(systemTheme());
  });
}
