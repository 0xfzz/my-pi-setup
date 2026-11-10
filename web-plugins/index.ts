import { artifactsPlugin } from "./artifacts.ts";
import { autoTitlePlugin } from "./auto-title.ts";
import { bubblySpinnerPlugin } from "./bubbly-spinner.ts";
import { cacheStatsPlugin } from "./cache-stats.ts";
import { exampleOverridePlugin } from "./example-override.ts";
import { modesPlugin } from "./modes.ts";
import { subagentCheckpointsPlugin } from "./subagent-checkpoints.ts";
import { subagentMonitorPlugin } from "./subagent-monitor.ts";
import { todoPlugin } from "./todo.ts";
import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const WEB_PLUGINS: readonly WebPluginDescriptor[] = [
  cacheStatsPlugin,
  todoPlugin,
  artifactsPlugin,
  subagentCheckpointsPlugin,
  subagentMonitorPlugin,
  bubblySpinnerPlugin,
  modesPlugin,
  autoTitlePlugin,
  exampleOverridePlugin,
];

export const WEB_PLUGIN_OPT_OUT: Record<string, string> = {
  "account-router":
    "Virtual model fallback chains and multi-account credential rotation; internal routing logic with no persistent view",
  agent:
    "Parent delegation engine, tool dispatch, and child lifecycle tracking; no persistent web view",
  "antigravity-accounts":
    "Multi-account provider registration for Google accounts; credential management without a web view",
  "ask-user":
    "Interactive clarification dialog; ephemeral interaction with no persistent view",
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
  providers:
    "Model provider discovery, configuration editor, and credential storage; interactive TUI editors",
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
