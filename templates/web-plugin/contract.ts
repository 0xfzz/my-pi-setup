import type { WebView } from "../../core/plugin-contracts/view.ts";

/**
 * The hello-world bridge contract: the plugin id, action ids and the pure view
 * factory that the pi extension (behavior) and the web descriptor (interface)
 * share.
 *
 *   - your extension imports this file to publish the view and answer the
 *     action (see the README for the two-line bridge),
 *   - web/plugins/<id>/descriptor.ts imports this file to declare them.
 *
 * No pi API, no web runtime, no I/O — only data, so a unit test pins it
 * directly. Copy this file to `web/plugins/<id>/contract.ts`.
 */
export const HELLO_WORLD_PLUGIN_ID = "hello-world";
export const HELLO_WORLD_GREET_ACTION = "greet";

/** Pure: input in, a validated `WebView` out. No session, no clock, no I/O. */
export function helloWorldWebView(greets: number): WebView {
  return {
    type: "kv",
    title: "Hello world",
    rows: [
      { label: "Plugin", value: HELLO_WORLD_PLUGIN_ID },
      { label: "Greetings published", value: String(greets) },
    ],
  };
}