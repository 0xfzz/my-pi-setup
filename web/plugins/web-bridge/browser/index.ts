/**
 * Web-bridge browser half: turns bridged envelopes into host-rendered
 * declarative views. It owns its view surface and plugin-owned styles; web/core
 * has no bridge component, CSS id or plugin-specific branch.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MESSAGE_CATALOG, type BridgeEnvelope } from "@pi-web/bridge";
import {
  installBrowserStyles,
  PluginViewRenderer,
  validateView,
  type WebView,
} from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { bridgedSurfaceId, bridgedView } from "../bridge-view.ts";
import { WEB_BRIDGE_PLUGIN_ID } from "../contract.ts";
import styles from "../web-bridge.css";

/** Every catalog event except the two core streams is a plugin surface. */
const SURFACES: readonly string[] = MESSAGE_CATALOG
  .filter((message) => message.kind === "event" && message.name !== "session.events" && message.name !== "session.directory.events")
  .map((message) => message.name);

const MAX_VIEWS = 12;

export function mount(el: HTMLElement, ctx: WebPluginContext): () => void {
  const removeStyles = installBrowserStyles(WEB_BRIDGE_PLUGIN_ID, styles);
  const surface = el.ownerDocument.createElement("aside");
  surface.className = "web-bridge-views";
  surface.dataset.pluginId = WEB_BRIDGE_PLUGIN_ID;
  surface.setAttribute("aria-label", "Bridged extension surfaces");
  el.appendChild(surface);
  const root = createRoot(surface);
  const views = new Map<string, WebView>();

  const draw = (): void => {
    root.render(
      createElement("div", { className: "web-bridge-view-list" },
        [...views.entries()].map(([key, view]) =>
          createElement(PluginViewRenderer, { key, view, hideTitle: false }))),
    );
  };

  const onEnvelope = (name: string) => (envelope: BridgeEnvelope): void => {
    const view = bridgedView(envelope);
    if (view === undefined || !validateView(view).ok) return;
    const key = bridgedSurfaceId(envelope);
    views.set(key, view);
    while (views.size > MAX_VIEWS) {
      const oldest = views.keys().next();
      if (oldest.done === true) break;
      views.delete(oldest.value);
    }
    ctx.register("ui.view", key, view);
    ctx.register("protocol.hooks", name, key);
    draw();
  };

  const unsubscribes = SURFACES.map((name) => {
    const listener = onEnvelope(name);
    ctx.register("protocol.hooks", name, listener);
    return ctx.protocol.subscribe(name, listener);
  });

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    root.unmount();
    surface.remove();
    removeStyles();
  };
}
