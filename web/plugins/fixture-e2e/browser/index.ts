/**
 * Independent fixture plugin: its only contact with the host is mount(el, ctx)
 * and the public registration context. No web/core branch knows this id.
 */
import type { WebPluginContext } from "@pi-web/bridge";

const RESTYLED = "fixture-transcript-restyled";

function makeComposer(ctx: WebPluginContext): HTMLElement {
  const doc = document;
  const panel = doc.createElement("div");
  panel.className = "fixture-composer";
  panel.dataset.fixture = "composer";
  const input = doc.createElement("input");
  input.className = "fixture-composer-input";
  input.placeholder = "Fixture composer";
  const run = doc.createElement("button");
  run.type = "button";
  run.className = "fixture-command-button";
  run.textContent = "Run fixture command";
  const result = doc.createElement("span");
  result.className = "fixture-command-result";
  run.addEventListener("click", () => {
    const command = ctx.contributions.list("commands").find((entry) => entry.key === "fixture.e2e.run");
    result.textContent = command === undefined ? "command missing" : String(command.value);
  });
  panel.append(input, run, result);
  return panel;
}

function registerContributions(ctx: WebPluginContext): void {
  ctx.register("ui.component.replace", "chat.composer", { owner: "fixture.e2e" });
  ctx.register("ui.region.wrap", "transcript", { tone: "fixture" });
  ctx.register("ui.page", "/plugins/fixture-e2e", () => {
    const page = document.createElement("div");
    page.className = "fixture-page";
    page.textContent = "Fixture page";
    return page;
  });
  ctx.register("commands", "fixture.e2e.run", "fixture command ran");
  ctx.register("keys", "Alt+Shift+F", "fixture.e2e.run");
  ctx.register("themes", "fixture-dark", { accent: "#7c3aed" });
  ctx.register("tokens", "accent", "#7c3aed");
  ctx.register("protocol.hooks", "ui.status.changed", () => undefined);
}

function renderPage(): void {
  if (globalThis.location?.pathname !== "/plugins/fixture-e2e") return;
  if (document.querySelector(".fixture-page") !== null) return;
  const page = document.createElement("div");
  page.className = "fixture-page";
  page.textContent = "Fixture page";
  document.body.appendChild(page);
}

export function mount(el: HTMLElement, ctx: WebPluginContext): () => void {
  const hidden = new Map<HTMLElement, string>();
  let panel: HTMLElement | undefined;
  let restyled: Element | undefined;
  let applying = false;

  const applyRegion = (): void => {
    if (applying) return;
    applying = true;
    try {
      const builtIn = document.querySelector<HTMLElement>(".app-composer");
      if (builtIn !== null && !hidden.has(builtIn)) {
        hidden.set(builtIn, builtIn.style.display);
        builtIn.style.display = "none";
      }
      if (builtIn !== null && (panel === undefined || !panel.isConnected)) {
        panel = makeComposer(ctx);
        builtIn.parentElement?.insertBefore(panel, builtIn);
        ctx.register("ui.component.replace", "chat.composer", { owner: "fixture.e2e" });
      }
      const transcript = document.querySelector(".app-transcript");
      if (transcript !== null && transcript !== restyled) {
        restyled?.classList.remove(RESTYLED);
        transcript.classList.add(RESTYLED);
        restyled = transcript;
        ctx.register("ui.region.wrap", "transcript", { tone: "fixture" });
      }
      renderPage();
    } finally {
      applying = false;
    }
  };

  registerContributions(ctx);
  applyRegion();
  const observer = new MutationObserver(applyRegion);
  observer.observe(document.body, { childList: true, subtree: true });
  ctx.logger.info("fixture.e2e browser half mounted");

  const restore = (): void => {
    observer.disconnect();
    panel?.remove();
    restyled?.classList.remove(RESTYLED);
    for (const [element, display] of hidden) element.style.display = display;
    hidden.clear();
    document.querySelector(".fixture-page")?.remove();
  };

  if (new URLSearchParams(globalThis.location?.search ?? "").get("fixtureThrow") === "1") {
    restore();
    throw new Error("fixture render failure");
  }
  return () => {
    restore();
    ctx.logger.info("fixture.e2e browser half unmounted");
  };
}
