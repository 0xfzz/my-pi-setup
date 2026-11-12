// Reference override plugin (see web/plugins/example-override.ts; the
// shared constants live in lib/example-override-web-view.ts): the
// "Replace the composer" action publishes a view; while it is published the
// web client renders that view instead of the composer region. Inert until
// the action runs, and a fresh session starts with no view again — the
// built-in region returns on its own.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../lib/web-plugins/actions.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import {
  EXAMPLE_OVERRIDE_PLUGIN_ID,
  EXAMPLE_OVERRIDE_SHOW_ACTION,
} from "../lib/example-override-web-view.ts";

export default function exampleOverrideExtension(pi: ExtensionAPI): void {
  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as { pluginId?: string; actionId?: string };
    if (request.pluginId !== EXAMPLE_OVERRIDE_PLUGIN_ID) return;
    if (request.actionId !== EXAMPLE_OVERRIDE_SHOW_ACTION) return;
    publishWebView(pi, EXAMPLE_OVERRIDE_PLUGIN_ID, {
      type: "status",
      tone: "accent",
      text: "Composer replaced by the example override plugin",
    });
  });
}
