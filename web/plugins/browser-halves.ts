/**
 * Plugin-owned browser halves. This registry lives outside web/core and is the
 * only place the composition root touches plugin code. Every half is declared
 * here with the metadata the operator sees; the core host checks the grant,
 * safe mode and point rules before any module is executed.
 */
import type { WebPluginContext } from "../core/client/plugin-system/browser-loader.ts";
import {
  createBrowserRuntimeHost,
  registerBrowserHalfFromUrl,
  type BrowserHalfDefinition,
  type BrowserRuntime,
} from "../core/client/plugin-system/browser-host.ts";
import { registerDiscoveredBrowserHalves } from "../core/client/plugin-system/discovered-browser-halves.ts";
import * as artifacts from "./artifacts/browser/index.ts";
import * as files from "./files/browser/index.ts";
import * as router from "./router/browser/index.ts";
import * as webBridge from "./web-bridge/browser/index.ts";
import * as fixture from "./fixture-e2e/browser/index.ts";

const CORE_HALVES: readonly BrowserHalfDefinition[] = [
  { id: "files", version: "1.0.0", sourcePath: "./browser/index.ts", capabilities: ["ui.panel"], trust: "trusted", corePlugin: true, module: files },
  { id: "artifacts", version: "1.0.0", sourcePath: "./browser/index.ts", capabilities: ["ui.panel"], trust: "trusted", corePlugin: true, module: artifacts },
  { id: "router", version: "1.0.0", sourcePath: "./browser/index.ts", capabilities: ["ui.panel"], trust: "trusted", corePlugin: true, module: router },
  { id: "web-bridge", version: "1.0.0", sourcePath: "./browser/index.ts", capabilities: ["ui.view", "protocol.subscribe"], trust: "trusted", corePlugin: true, module: webBridge },
];

/** The fixture project is opt-in so an ordinary web session is unaffected. */
function definitions(): readonly BrowserHalfDefinition[] {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  if (params.get("fixture") !== "1") return CORE_HALVES;
  return [...CORE_HALVES, {
    id: "fixture.e2e",
    version: "0.1.0",
    sourcePath: "./browser/index.ts",
    capabilities: ["ui.replace", "commands", "keys", "themes", "ui.page", "protocol.hooks"],
    trust: "trusted",
    module: fixture,
  }];
}

declare global {
  interface Window {
    piBrowserRuntime?: BrowserRuntime;
    piBrowserRegisterHalf?: (info: { id: string; version: string; url: string; capabilities: readonly string[] }) => Promise<void>;
  }
}

export function mountPluginBrowserHalves(el: HTMLElement, ctx: Omit<WebPluginContext, "register" | "contributions">): () => void {
  const staticDefinitions = definitions();
  const runtime = createBrowserRuntimeHost({
    definitions: staticDefinitions,
    element: el,
    context: ctx,
  });
  globalThis.window.piBrowserRuntime = runtime;
  globalThis.window.piBrowserRegisterHalf = (info) => registerBrowserHalfFromUrl(runtime, { ...info, sourcePath: info.url });

  let stopped = false;
  void registerDiscoveredBrowserHalves(runtime, { staticIds: staticDefinitions.map((half) => half.id) })
    .then((report) => {
      for (const error of report.errors) ctx.logger.warn(`discovered browser half was skipped: ${error}`);
    })
    .catch((error: unknown) => {
      ctx.logger.warn(`browser-half discovery failed: ${String(error)}`);
    })
    .finally(() => {
      if (!stopped) void runtime.scan();
    });

  return () => {
    stopped = true;
    runtime.stop();
    delete globalThis.window.piBrowserRuntime;
    delete globalThis.window.piBrowserRegisterHalf;
  };
}
