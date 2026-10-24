import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, parseSessionEntries, getAgentDir } from "@earendil-works/pi-coding-agent";

const moduleFile = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFile);

export interface VccRecallResult {
  output: string;
  count: number;
  totalPages?: number;
}

/**
 * Drop entries a fork seed already copied into the child.
 *
 * `loadAllMessages` returns `rendered`/`rawMessages`/`entryIds` pushed together,
 * so the three arrays are position-aligned even when `rendered[i].index` skips
 * gaps. Positions are therefore the only safe join key here.
 */
function excludeSeeded(
  rendered: any[],
  rawMessages: any[],
  entryIds: string[],
  exclude?: Set<string>,
): { rendered: any[]; rawMessages: any[]; excludedIndices: Set<number> } {
  const excludedIndices = new Set<number>();
  if (!exclude?.size) return { rendered, rawMessages, excludedIndices };
  const keptRendered: any[] = [];
  const keptMessages: any[] = [];
  for (let position = 0; position < rendered.length; position++) {
    const id = entryIds[position];
    if (typeof id === "string" && exclude.has(id)) {
      excludedIndices.add(rendered[position].index);
      continue;
    }
    keptRendered.push(rendered[position]);
    keptMessages.push(rawMessages[position]);
  }
  return { rendered: keptRendered, rawMessages: keptMessages, excludedIndices };
}

let jitiInstance: any = null;
let compileModule: any = null;
let loadMessagesModule: any = null;
let searchEntriesModule: any = null;
let formatRecallModule: any = null;
let lineageModule: any = null;
let initFailed = false;

/** Agent directory, tolerating a runtime that cannot resolve it. */
function agentDir(): string | undefined {
  try { return getAgentDir(); } catch { return undefined; }
}

/** Resolve a package root through Node's own algorithm, as installed for this
 * process, so nothing depends on a machine-specific absolute path. */
function resolvePackageDir(specifier: string): string | undefined {
  const req = createRequire(import.meta.url);
  const fromEntry = (entry: string): string | undefined => {
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
    return undefined;
  };
  // package.json is exported by nearly every package and sits at the root.
  try { return dirname(req.resolve(`${specifier}/package.json`)); } catch { /* not exported */ }
  try { return fromEntry(req.resolve(specifier)); } catch { /* import-only exports */ }
  // Some packages (pi-coding-agent) expose only an "import" condition, which
  // CJS require cannot see. Fall back to ESM resolution.
  try { return fromEntry(fileURLToPath(import.meta.resolve(specifier))); } catch { /* unresolvable */ }
  return undefined;
}

function resolveVccRoot(): string {
  if (process.env.VCC_ROOT && existsSync(process.env.VCC_ROOT)) {
    return process.env.VCC_ROOT;
  }
  const resolved = resolvePackageDir("pi-vcc");
  if (resolved && existsSync(resolved)) return resolved;
  const dir = agentDir();
  const candidates = [
    // Pi installs package extensions under <agentDir>/npm/node_modules.
    ...(dir ? [join(dir, "npm", "node_modules", "pi-vcc")] : []),
    resolve(process.cwd(), "node_modules/pi-vcc"),
    resolve(moduleDir, "../node_modules/pi-vcc"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

function resolvePiRuntime(): string {
  if (process.env.PI_RUNTIME_ROOT && existsSync(process.env.PI_RUNTIME_ROOT)) {
    return process.env.PI_RUNTIME_ROOT;
  }
  // The directory holding the running Pi packages, wherever Pi was installed.
  const resolved = resolvePackageDir("@earendil-works/pi-coding-agent");
  if (resolved) {
    // `.../node_modules/@earendil-works/pi-coding-agent` -> `.../node_modules`
    const nodeModules = resolve(resolved, "..", "..");
    if (existsSync(join(nodeModules, "jiti"))) return nodeModules;
  }
  return resolve(process.cwd(), "node_modules");
}

function getJiti() {
  if (jitiInstance) return jitiInstance;
  const runtime = resolvePiRuntime();
  const req = createRequire(import.meta.url);
  const jitiPath = `${runtime}/jiti`;
  const { createJiti } = req(jitiPath);
  const bridgePath = resolve(moduleDir, "pi-bridge.cjs");
  jitiInstance = createJiti(moduleFile, {
    fsCache: false,
    alias: {
      "@mariozechner/pi-coding-agent": bridgePath,
      "@mariozechner/pi-ai": `${runtime}/@earendil-works/pi-ai/dist/index.js`,
      "@mariozechner/pi-tui": `${runtime}/@earendil-works/pi-tui/dist/index.js`,
    },
  });
  return jitiInstance;
}

function ensureVccModules(): boolean {
  if (compileModule && loadMessagesModule && searchEntriesModule && formatRecallModule && lineageModule) {
    return true;
  }
  if (initFailed) return false;
  try {
    const vccRoot = resolveVccRoot();
    const j = getJiti();
    compileModule = j(`${vccRoot}/src/core/summarize.ts`);
    loadMessagesModule = j(`${vccRoot}/src/core/load-messages.ts`);
    searchEntriesModule = j(`${vccRoot}/src/core/search-entries.ts`);
    formatRecallModule = j(`${vccRoot}/src/core/format-recall.ts`);
    lineageModule = j(`${vccRoot}/src/core/lineage.ts`);
    return true;
  } catch (err) {
    console.warn("[vcc-subagent-adapter] Failed to initialize pi-vcc:", (err as Error).message);
    initFailed = true;
    return false;
  }
}

/**
 * Algorithmic compilation of a subagent session branch using VCC (0 LLM tokens).
 * Produces structured sections: Goals, Files And Changes, Commits, Key Signals, Tool Rollup.
 */
export async function compileSubagentSession(sessionFile: string): Promise<string | undefined> {
  if (!existsSync(sessionFile)) return undefined;
  if (!ensureVccModules()) return undefined;

  try {
    const fileEntries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
    const header = fileEntries.find((e: any) => e.type === "session");
    if (!header) return undefined;

    const sm = SessionManager.inMemory((header as any).cwd, undefined, fileEntries);
    const lineage = lineageModule.getActiveLineageEntryIds(sm);
    const { rawMessages } = await loadMessagesModule.loadAllMessages(sessionFile, false, lineage);

    if (!rawMessages || rawMessages.length === 0) return undefined;

    const summary = await compileModule.compile({ messages: rawMessages });
    return summary || undefined;
  } catch (err) {
    console.warn(`[vcc-subagent-adapter] Compilation failed for ${sessionFile}:`, (err as Error).message);
    return undefined;
  }
}

const PAGE_SIZE = 5;

/**
 * Indexed search or expansion of a child subagent session using VCC.
 */
export async function recallSubagentHistory(params: {
  sessionFile: string;
  query?: string;
  expand?: number[];
  page?: number;
  scope?: "lineage" | "all";
  /** Entry ids to omit because the caller already holds them (fork seed prefix). */
  excludeEntryIds?: Set<string>;
}): Promise<VccRecallResult> {
  if (!existsSync(params.sessionFile)) {
    throw new Error(`Child session file does not exist: ${params.sessionFile}`);
  }
  if (!ensureVccModules()) {
    throw new Error("pi-vcc modules are unavailable on this system.");
  }

  const fileEntries = parseSessionEntries(readFileSync(params.sessionFile, "utf8"));
  const header = fileEntries.find((e: any) => e.type === "session");
  if (!header) throw new Error("Saved child session has no valid header.");

  const scope = params.scope === "all" ? "all" : "lineage";
  const sm = SessionManager.inMemory((header as any).cwd, undefined, fileEntries);
  const lineageEntryIds = scope === "lineage" ? lineageModule.getActiveLineageEntryIds(sm) : undefined;

  const expandSet = new Set(params.expand ?? []);
  const hasExpand = expandSet.size > 0;

  if (hasExpand && !params.query) {
    const loaded = await loadMessagesModule.loadAllMessages(params.sessionFile, true, lineageEntryIds);
    const { rendered: visible, excludedIndices } = excludeSeeded(
      loaded.rendered, loaded.rawMessages, loaded.entryIds ?? [], params.excludeEntryIds,
    );
    const requested = [...expandSet];
    const byIndex = new Map(visible.map((m: any) => [m.index, m]));
    const invalid = requested.filter((i) => !Number.isInteger(i) || !byIndex.has(i));
    if (invalid.length > 0) {
      const seeded = invalid.filter((i) => excludedIndices.has(i));
      const reason = seeded.length === invalid.length
        ? `already present in your own context (copied at seed): ${seeded.join(", ")}`
        : `outside child session ${scope}${seeded.length ? ` (${seeded.join(", ")} copied at seed)` : ""}`;
      throw new Error(`Cannot expand indices ${reason}: ${invalid.filter((i) => !excludedIndices.has(i)).join(", ") || "none"}`);
    }

    const expanded = requested.map((i) => byIndex.get(i)).filter(Boolean);
    const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallModule.formatRecallOutput(expanded);
    return { output, count: expanded.length };
  }

  const loaded = await loadMessagesModule.loadAllMessages(params.sessionFile, false, lineageEntryIds);
  const { rendered: msgs, rawMessages } = excludeSeeded(
    loaded.rendered, loaded.rawMessages, loaded.entryIds ?? [], params.excludeEntryIds,
  );
  const allResults = params.query?.trim()
    ? searchEntriesModule.searchEntries(msgs, rawMessages, params.query)
    : msgs.slice(-25);

  if (params.query?.trim()) {
    const page = Math.max(1, params.page ?? 1);
    const start = (page - 1) * PAGE_SIZE;
    const pageResults = allResults.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
    const scopeSuffix = scope === "all" ? " (scope: all)" : "";
    const headerText = totalPages > 1
      ? `Child session matches — Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
      : `Child session matches — ${allResults.length} match(es)${scopeSuffix}`;
    const footer = page < totalPages
      ? `\n--- Use page:${page + 1} to see more, or expand:[index] for untruncated content ---`
      : "\n--- Use expand:[index] for untruncated content ---";

    const output = formatRecallModule.formatRecallOutput(pageResults, params.query, headerText) + footer;
    return { output, count: allResults.length, totalPages };
  }

  const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallModule.formatRecallOutput(allResults, params.query);
  return { output, count: allResults.length };
}
