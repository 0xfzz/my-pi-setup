/**
 * First-party web plugins and the pi extensions intentionally without a web
 * surface. Add one descriptor here to register a plugin with the host.
 */
import { artifactsPlugin } from "../plugins/artifacts/descriptor.ts";
import { askUserPlugin } from "../plugins/ask-user/descriptor.ts";
import { autoTitlePlugin } from "../plugins/auto-title/descriptor.ts";
import { bubblySpinnerPlugin } from "../plugins/bubbly-spinner/descriptor.ts";
import { cacheStatsPlugin } from "../plugins/cache-stats/descriptor.ts";
import { exampleOverridePlugin } from "../plugins/example-override/descriptor.ts";
import { mcpManagerPlugin } from "../plugins/mcp-manager/descriptor.ts";
import { modesPlugin } from "../plugins/modes/descriptor.ts";
import { pluginManagerPlugin } from "../plugins/plugin-manager/descriptor.ts";
import { providersPlugin } from "../plugins/providers/descriptor.ts";
import { routerEditorPlugin, routerPlugin } from "../plugins/router/descriptor.ts";
import { subagentCheckpointsPlugin } from "../plugins/subagent-checkpoints/descriptor.ts";
import { subagentGraphPlugin } from "../plugins/subagent-graph/descriptor.ts";
import { todoPlugin } from "../plugins/todo/descriptor.ts";
import { webBridgePlugin } from "../plugins/web-bridge/descriptor.ts";
import type { WebPluginDescriptor } from "../core/plugin-contracts/descriptor.ts";

/** Every first-party descriptor the composition root registers. */
export const WEB_PLUGINS: readonly WebPluginDescriptor[] = Object.freeze([
  cacheStatsPlugin,
  todoPlugin,
  artifactsPlugin,
  subagentCheckpointsPlugin,
  subagentGraphPlugin,
  bubblySpinnerPlugin,
  modesPlugin,
  autoTitlePlugin,
  askUserPlugin,
  mcpManagerPlugin,
  pluginManagerPlugin,
  providersPlugin,
  routerPlugin,
  routerEditorPlugin,
  exampleOverridePlugin,
  webBridgePlugin,
]);

/** Pi extensions with no web descriptor, and the reason they are absent. */
export const WEB_PLUGIN_OPT_OUT: Readonly<Record<string, string>> = Object.freeze({
  agent:
    "Parent delegation engine, tool dispatch, and child lifecycle tracking; no persistent web view",
  "antigravity-accounts":
    "Multi-account provider registration for Google accounts; credential management without a web view",
  "cache-breakpoints":
    "Prompt-cache breakpoint injection on volatile message tails; invisible background middleware",
  "cache-trace":
    "Opt-in diagnostic logging cache prefix sharing to JSONL; no persistent view",
  "clipboard-paste":
    "Terminal clipboard paste handler across Linux protocols; input-only tool",
  "dynamic-prompt":
    "Registry-driven system prompt builder; background prompt middleware",
  "image-thumbnails":
    "Downscaled image previews for terminal rendering; TUI-only media optimization",
  "prompt-ui":
    "Interactive popup prompt selector and editor; TUI-only dialog",
  sidebar:
    "TUI-only sidebar layout, chrome, aquarium animation, and split rendering",
  "smart-timeout":
    "Bash execution timeout and idle process watchdog; background execution policy",
  "stream-recovery":
    "Interrupted tool-generation checkpoints and suffix recovery; background middleware with command/tool output, no dedicated web view",
  "web-read":
    "Headless browser page reader tool for web retrieval; tool-only execution",
  web:
    "Web UI process management and single-instance server launcher; control command with no persistent view",
});
