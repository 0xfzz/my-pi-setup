import type { WebView } from "./web-plugins/view.ts";

/**
 * Shared constants and the pure view factory for the `hello-world` plugin.
 *
 * This file is the neutral ground both halves import (see the plugin contract
 * in `lib/web-plugins/`): the extension publishes the view, the web descriptor
 * declares it, and the client renders it. No pi API, no web runtime, no I/O —
 * only data, so it is the part a unit test pins directly.
 */

/** Web plugin id and the actions it declares. Shared by the extension and its descriptor. */
export const HELLO_WORLD_PLUGIN_ID = "hello-world";
/** Instant, reversible action: re-publishes the greeting with an incremented count. */
export const HELLO_WORLD_GREET_ACTION = "greet";

/** A pure function: input in, a validated `WebView` out. No session, no clock, no I/O. */
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