/**
 * `mcp.read` / `mcp.write` — pi's MCP server configuration, called natively.
 *
 * The web MCP manager port: the same config pi's `/mcp` and `pi mcp` show and
 * edit, read through `loadMcpConfig` and written through pi's own config
 * mutators (`addMcpServerConfig`, `removeMcpServerConfig`,
 * `updateMcpServerConfig`). The web never hand-edits an mcp.json — pi owns the
 * file format, the override rules and the indentation-preserving rewrites.
 *
 * A written change takes effect like the TUI's: a running session applies it
 * on `/reload` (the plugin's Reload action), a new session on start.
 */
import { join } from "node:path";
import type {
  PiApiContext,
  PiApiModule,
} from "./types.ts";
import type { PiMcpConfigState, PiMcpScope, PiMcpServerEntry, PiMcpWriteParams } from "../shared/pi-api.ts";

/** pi's own MCP config surface, structural (deep module re-exported by the package). */
interface McpServerEntry {
  name: string;
  config: Record<string, unknown>;
  source: string;
  scope?: PiMcpScope;
  override?: string;
}
interface LoadedMcpConfig {
  servers: McpServerEntry[];
  autoEnableCodemode?: boolean;
  errors: string[];
  projectConfig?: string;
}
interface McpConfigPatch {
  enabled?: boolean;
  exposure?: string;
}
interface McpConfigApi {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  updateMcpServerConfig(path: string, name: string, patch: McpConfigPatch, options?: { override?: boolean }): void;
  addMcpServerConfig(path: string, name: string, config: Record<string, unknown>): boolean;
  removeMcpServerConfig(path: string, name: string): boolean;
}
interface McpValidator {
  /** pi's entry validator: a validated copy, or an error message. */
  validateMcpServerConfig(name: string, raw: unknown): Record<string, unknown> | string;
}
interface TrustDecisionStore {
  getEntry(cwd: string): { path: string; decision: boolean } | null;
}

async function loadPiMcpModules(): Promise<{ config: McpConfigApi; validator: McpValidator }> {
  const [config, validator] = await Promise.all([
    import("../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js"),
    import("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js"),
  ]);
  return {
    config: config as unknown as McpConfigApi,
    validator: validator as unknown as McpValidator,
  };
}

async function loadAgentDir(): Promise<string> {
  const pi = await import("@earendil-works/pi-coding-agent");
  return pi.getAgentDir();
}

/** pi's project-trust decision for `cwd` — the gate for all project writes. */
async function isProjectTrusted(agentDir: string, cwd: string): Promise<boolean> {
  const trustManager = await import(
    "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js"
  );
  const store = new (trustManager as { ProjectTrustStore: new (agentDir: string) => TrustDecisionStore })
    .ProjectTrustStore(agentDir);
  return store.getEntry(cwd)?.decision === true;
}

/** Read the merged MCP state pi itself would connect with. */
async function readMcpState(cwd: string): Promise<PiMcpConfigState> {
  const [{ config }, agentDir] = await Promise.all([loadPiMcpModules(), loadAgentDir()]);
  const trusted = await isProjectTrusted(agentDir, cwd);
  const loaded = config.loadMcpConfig({ agentDir, cwd, projectTrusted: trusted });
  return {
    servers: loaded.servers.map(toWireEntry),
    globalConfigPath: join(agentDir, "mcp.json"),
    projectConfigPath: loaded.projectConfig ?? null,
    projectTrusted: trusted,
    autoEnableCodemode: loaded.autoEnableCodemode ?? true,
    errors: loaded.errors,
  };
}

/** Wire form of one entry: the fields the manager page renders. */
function toWireEntry(entry: McpServerEntry): PiMcpServerEntry {
  const config = entry.config;
  const hasCommand = typeof config.command === "string" && config.command !== "";
  const wire: PiMcpServerEntry = {
    name: entry.name,
    scope: entry.scope ?? "global",
    source: entry.source,
    enabled: config.enabled !== false,
    exposure: typeof config.exposure === "string" ? config.exposure : "codemode",
    transport: hasCommand ? "stdio" : "http",
  };
  if (entry.override !== undefined) wire.override = entry.override;
  if (hasCommand) {
    wire.command = config.command as string;
    if (Array.isArray(config.args)) wire.args = config.args as string[];
  } else if (typeof config.url === "string") {
    wire.url = config.url;
  }
  if (isStringRecord(config.env)) wire.env = config.env;
  if (isStringRecord(config.headers)) wire.headers = config.headers;
  if (typeof config.description === "string") wire.description = config.description;
  return wire;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

/** The entry whose file a `patch` writes to: the override, else the definer. */
function patchTarget(state: PiMcpConfigState, name: string): PiMcpServerEntry {
  const entry = state.servers.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no configured server named ${name}`);
  return entry;
}

/** Run one validated mutation, then return the fresh state. */
async function applyMcpWrite(cwd: string, params: PiMcpWriteParams): Promise<PiMcpConfigState> {
  const [{ config, validator }, state] = await Promise.all([loadPiMcpModules(), readMcpState(cwd)]);
  switch (params.action) {
    case "add": {
      const validated = validator.validateMcpServerConfig(params.name, params.config);
      if (typeof validated === "string") throw new Error(validated);
      const target = params.scope === "project" ? requireProjectConfig(state) : state.globalConfigPath;
      config.addMcpServerConfig(target, params.name, validated);
      break;
    }
    case "remove": {
      const target = params.scope === "project" ? requireProjectConfig(state) : state.globalConfigPath;
      if (!config.removeMcpServerConfig(target, params.name)) {
        throw new Error(`${target} does not define ${params.name}`);
      }
      break;
    }
    case "patch": {
      const entry = patchTarget(state, params.name);
      config.updateMcpServerConfig(entry.override ?? entry.source, params.name, patchOf(params));
      break;
    }
    case "override": {
      const target = requireProjectConfig(state);
      config.updateMcpServerConfig(target, params.name, patchOf(params), { override: true });
      break;
    }
  }
  return readMcpState(cwd);
}

/** The project mcp.json, which only a trusted project has. */
function requireProjectConfig(state: PiMcpConfigState): string {
  if (state.projectConfigPath === null) {
    throw new Error("project is not trusted: project-level MCP changes are unavailable");
  }
  return state.projectConfigPath;
}

function patchOf(params: { enabled?: boolean; exposure?: string }): McpConfigPatch {
  const patch: McpConfigPatch = {};
  if (params.enabled !== undefined) patch.enabled = params.enabled;
  if (params.exposure !== undefined) patch.exposure = params.exposure;
  return patch;
}

export const mcpReadApi: PiApiModule = {
  api: "mcp.read",

  handle(_params: unknown, ctx: PiApiContext): Promise<unknown> {
    return readMcpState(ctx.cwd);
  },
};

export const mcpWriteApi: PiApiModule = {
  api: "mcp.write",

  handle(params: unknown, ctx: PiApiContext): Promise<unknown> {
    return applyMcpWrite(ctx.cwd, params as PiMcpWriteParams);
  },
};
