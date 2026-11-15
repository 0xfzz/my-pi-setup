import { artifactsPlugin } from "./artifacts/descriptor.ts";
import { askUserPlugin } from "./ask-user/descriptor.ts";
import { autoTitlePlugin } from "./auto-title/descriptor.ts";
import { bubblySpinnerPlugin } from "./bubbly-spinner/descriptor.ts";
import { cacheStatsPlugin } from "./cache-stats/descriptor.ts";
import { exampleOverridePlugin } from "./example-override/descriptor.ts";
import { mcpManagerPlugin } from "./mcp-manager/descriptor.ts";
import { modesPlugin } from "./modes/descriptor.ts";
import { pluginManagerPlugin } from "./plugin-manager/descriptor.ts";
import { providersPlugin } from "./providers/descriptor.ts";
import { subagentCheckpointsPlugin } from "./subagent-checkpoints/descriptor.ts";
import { subagentGraphPlugin } from "./subagent-graph/descriptor.ts";
import { todoPlugin } from "./todo/descriptor.ts";
import type { WebPluginDescriptor } from "../core/plugin-contracts/descriptor.ts";

export const WEB_PLUGINS: readonly WebPluginDescriptor[] = [
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
  exampleOverridePlugin,
];

export const WEB_PLUGIN_OPT_OUT: Record<string, string> = {
  "account-router":
    "Virtual model fallback chains, multi-account credential rotation and prompt-cache-aware routing; the routing view is TUI-only (/router status, /router why) and has no web surface yet",
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
};
