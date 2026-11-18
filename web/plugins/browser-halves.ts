/**
 * Plugin-owned browser halves. The client runtime discovers trusted halves
 * from their manifests through `/api/browser-halves`; this module only starts
 * that runtime with the shared bridge context. web/core imports no plugin.
 */
import type { WebPluginContext } from "../core/client/plugin-system/browser-loader.ts";
import {
  createBrowserRuntimeHost,
  registerBrowserHalfFromUrl,
  type BrowserRuntime,
} from "../core/client/plugin-system/browser-host.ts";
import { registerDiscoveredBrowserHalves } from "../core/client/plugin-system/discovered-browser-halves.ts";

declare global {
  interface Window {
    piBrowserRuntime?: BrowserRuntime;
    piBrowserRegisterHalf?: (info: { id: string; version: string; url: string; capabilities: readonly string[] }) => Promise<void>;
  }
}

export function mountPluginBrowserHalves(el: HTMLElement, ctx: Omit<WebPluginContext, "register" | "contributions">): () => void {
  const runtime = createBrowserRuntimeHost({
    definitions: [],
    element: el,
    context: ctx,
  });
  globalThis.window.piBrowserRuntime = runtime;
  globalThis.window.piBrowserRegisterHalf = (info) => registerBrowserHalfFromUrl(runtime, { ...info, sourcePath: info.url });

  void registerDiscoveredBrowserHalves(runtime)
    .then((report) => {
      for (const error of report.errors) ctx.logger.warn(`discovered browser half was skipped: ${error}`);
    })
    .catch((error: unknown) => {
      ctx.logger.warn(`browser-half discovery failed: ${String(error)}`);
    });

  return () => {
    runtime.stop();
    delete globalThis.window.piBrowserRuntime;
    delete globalThis.window.piBrowserRegisterHalf;
  };
}
