import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentConfigDir } from "./agents.ts";

export interface SubagentSettings {
  defaultModel?: string; // "inherit" | "provider/model" | undefined
  /**
   * Per-role model bindings for the orchestrator's children.
   *
   * Shape: `{ "devil-advocate": "inherit", "worker": [{ provider, model }, …] }`.
   * Kept as unknown here so an older build never rewrites a newer file's shape;
   * `lib/delegation/role-models.ts` validates and normalises on read.
   */
  roleModels?: Record<string, unknown>;
  /** Friendly names for awkward provider/model ids, resolved before validation. */
  modelAliases?: Record<string, { provider: string; model: string }>;
  /** Max children this process may have running at once. Absent = default. */
  maxDelegates?: number;
  /**
   * Occupancy-aware delegation ceiling an owner session may hold at once
   * (running + blocked + results awaiting parent review). Absent = default 2;
   * the strictest explicitly configured value wins over the default, never the
   * reverse, so a migrated setup keeps the ceiling its owner chose.
   */
  maxConcurrentDelegations?: number;
  /**
   * Successful child launches allowed per work batch, before the user resets
   * the batch with /agent batch. Absent = default 4.
   */
  maxLaunchesPerBatch?: number;
}

export function getSubagentSettingsFile(
  scope: "global" | "project" = "global",
  cwd?: string,
): string {
  if (scope === "project") {
    return join(cwd ?? process.cwd(), ".pi", "subagents.json");
  }
  return join(getAgentConfigDir(), "subagents.json");
}

export function loadSubagentSettings(cwd?: string): SubagentSettings {
  const globalPath = getSubagentSettingsFile("global");
  const projectPath = getSubagentSettingsFile("project", cwd);
  let settings: SubagentSettings = {};

  if (existsSync(globalPath)) {
    try {
      const content = readFileSync(globalPath, "utf8").trim();
      if (content) {
        settings = { ...settings, ...JSON.parse(content) };
      }
    } catch {
      // Ignore corrupt or unreadable files gracefully
    }
  }

  if (existsSync(projectPath)) {
    try {
      const content = readFileSync(projectPath, "utf8").trim();
      if (content) {
        settings = { ...settings, ...JSON.parse(content) };
      }
    } catch {
      // Ignore corrupt or unreadable files gracefully
    }
  }

  return settings;
}

export function saveSubagentSettings(
  updates: Partial<SubagentSettings>,
  options?: { scope?: "global" | "project"; cwd?: string },
): void {
  const targetPath = getSubagentSettingsFile(options?.scope ?? "global", options?.cwd);
  mkdirSync(dirname(targetPath), { recursive: true });

  let existing: SubagentSettings = {};
  if (existsSync(targetPath)) {
    try {
      const content = readFileSync(targetPath, "utf8").trim();
      if (content) {
        existing = JSON.parse(content);
      }
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, ...updates };
  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
