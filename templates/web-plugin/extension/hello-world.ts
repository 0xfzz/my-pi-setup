import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  HELLO_WORLD_GREET_ACTION,
  HELLO_WORLD_PLUGIN_ID,
  helloWorldWebView,
} from "../lib/hello-world-web-view.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../web/core/plugin-contracts/actions.ts";
import { publishWebView } from "../web/core/plugin-contracts/publisher.ts";

/**
 * Reference bridge in both directions. Copy this file to `extensions/hello-world.ts`
 * and add `"./extensions/hello-world.ts"` to the root `package.json` → `pi.extensions`.
 *
 *   extension → web   publishWebView(pi, PLUGIN_ID, view)     pushes a declarative view
 *   web → extension   pi.events.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, …)  receives a declared action
 *
 * All decisions and the view shape live in `lib/hello-world-web-view.ts`; this
 * file only wires, so it stays a thin adapter (see the clean-code skill).
 */
export default function helloWorldExtension(pi: ExtensionAPI) {
  let greets = 0;

  const publish = () => {
    greets += 1;
    publishWebView(pi, HELLO_WORLD_PLUGIN_ID, helloWorldWebView(greets));
  };

  // Publish the first view when a session starts (the web shows it in the
  // declared region/slot, per the descriptor).
  pi.on("session_start", () => publish());

  // A TUI command is optional; it proves the same publish path works from the
  // terminal and gives the operator a way to nudge the view.
  pi.registerCommand("hello", {
    description: "Re-publish the hello-world web view",
    handler: async (_args, ctx) => {
      publish();
      ctx.ui.notify("Published the hello-world view.", "info");
    },
  });

  // The bridge in the other direction: the web forwards a declared action as
  // WEB_PLUGIN_ACTION_REQUEST_EVENT. Match plugin id first, then action id.
  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId !== HELLO_WORLD_PLUGIN_ID || request.actionId !== HELLO_WORLD_GREET_ACTION) return;
    publish();
  });
}