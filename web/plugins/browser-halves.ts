/**
 * Plugin-owned browser halves. This registry lives outside web/core and is the
 * only place the composition root touches plugin code; each half owns its own
 * panel registration and cleanup.
 */
import type { WebPluginContext } from "../core/client/plugin-system/browser-loader.ts";
import * as artifacts from "./artifacts/browser/index.ts";
import * as files from "./files/browser/index.ts";
import * as router from "./router/browser/index.ts";

const HALVES = [files, artifacts, router] as const;

export function mountPluginBrowserHalves(el: HTMLElement, ctx: WebPluginContext): () => void {
  const cleanups = HALVES.map((half) => half.mount(el, ctx));
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
