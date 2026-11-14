// Client-side custom page registration for the first-party plugins. A plugin
// whose page surface renders a bespoke tool registers its component here at
// import time; PluginLayout reads the core registry and never imports a
// plugin directly. Adding a custom page is one line.

import { registerPluginPage } from "../core/client/plugin-system/page-registry.ts";
import { MCP_MANAGER_PLUGIN_ID } from "./mcp-manager/contract.ts";
import { McpManagerPage } from "./mcp-manager/McpManagerPage.tsx";
import { PLUGIN_MANAGER_PLUGIN_ID } from "./plugin-manager/contract.ts";
import { PluginManagerPage } from "./plugin-manager/PluginManagerPage.tsx";

registerPluginPage(MCP_MANAGER_PLUGIN_ID, McpManagerPage);
registerPluginPage(PLUGIN_MANAGER_PLUGIN_ID, PluginManagerPage);
