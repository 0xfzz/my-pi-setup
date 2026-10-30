/**
 * Where the effective scope comes from: a config file, the branch, and the cwd.
 *
 * Precedence, narrowest-last:
 *
 *   global config (`~/.pi/agent/scope.json`)
 *   → project config (`<cwd>/.pi/scope.json`, may also be written by `/scope … --project`)
 *   → branch records (`/scope allow` during this session, replayed on resume/fork)
 *
 * The branch carries a full **snapshot**, not a delta. A fork copies the branch
 * entries of its ancestors, so a snapshot means "this is what was granted up to
 * here" and replaying it twice cannot double-apply. opencode's grants were rows
 * in a project-scoped table, which is why they leaked into forks and later
 * sessions (issue #30779); a snapshot on the transcript cannot leak past the
 * branch that contains it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalize, expandHome, lexicalInside, literalPrefix, toResourceSlash } from "./paths.ts";
import {
  DEFAULT_SCOPE_DEFAULTS,
  isUnsafeRoot,
  SCOPE_RECORD_TYPE,
  type ScopeAccess,
  type ScopeEffect,
  type ScopeRecord,
  type ScopeRoot,
  type ScopeRule,
  type ScopeState,
  type ScopeYolo,
} from "./types.ts";

export interface ScopeConfigFile {
  roots?: Array<string | { path: string; access?: ScopeAccess }>;
  rules?: ScopeRule[];
  defaults?: { external?: ScopeEffect; readExternal?: ScopeEffect; unknown?: ScopeEffect };
  /**
   * Accepted so a hand-written file with the key is reported instead of
   * ignored: MCP tools bypass this gate and there is no path field to declare.
   */
  mcp?: unknown;
  /** Accepted so a hand-written file with the key is rejected loudly, not ignored. */
  yolo?: unknown;
}

export interface LoadedScope {
  state: ScopeState;
  /** Files that contributed, in precedence order (for `/scope status`). */
  sources: string[];
  /** Problems worth showing the user instead of silently ignoring. */
  problems: string[];
}

function relativeTo(base: string, path: string): string {
  const resolved = resolve(base, expandHome(path));
  return canonicalize(resolved);
}

/**
 * Normalize configured roots, refusing patterns that would re-expose the machine.
 *
 * A root may be a glob (`~/projects/*`). Safety is decided by the **literal
 * prefix**, which a `*` can never escape — the same test `suggestGrant` applies
 * to a dialog answer. A pattern with no directory to stand on is reported rather
 * than stored, because an inert root is indistinguishable from a granted one.
 */
function normalizeRoots(
  roots: ScopeConfigFile["roots"],
  base: string,
  source: ScopeRoot["source"],
  problems: string[],
): ScopeRoot[] {
  const out: ScopeRoot[] = [];
  for (const entry of roots ?? []) {
    const raw = typeof entry === "string" ? entry : entry.path;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const access = typeof entry === "string" ? "rw" : (entry.access ?? "rw");
    const path = relativeTo(base, raw);
    if (/[*?]/.test(path)) {
      const prefix = literalPrefix(path).replace(/\/+$/, "");
      if (!prefix || isUnsafeRoot(prefix, homedir()) || lexicalInside(prefix, base)) {
        problems.push(
          `Ignoring root ${raw}: a pattern there would re-expose ${prefix || "/"} or a directory containing the workspace.`,
        );
        continue;
      }
      if (!existsSync(prefix)) {
        problems.push(`Root pattern ${raw} grants nothing: ${prefix} does not exist.`);
        continue;
      }
    }
    out.push({ path, access, source });
  }
  return out;
}

/**
 * `~`, `~/` and `$HOME` at the start of a rule resource expand.
 *
 * Without this the rule spelling of a folder grant is dead on arrival: external
 * resources are absolute, so `~/projects/*` could never match one.
 */
function expandRuleResource(resource: string): string {
  return toResourceSlash(expandHome(resource));
}

/** Read and merge the two config files. Missing files are normal, not errors. */
export function loadScopeConfig(cwd: string, records?: ScopeRecord | undefined): LoadedScope {
  const problems: string[] = [];
  const sources: string[] = [];
  const globalPath = join(homedir(), ".pi", "agent", "scope.json");
  const projectPath = join(cwd, ".pi", "scope.json");
  const files: Array<{ path: string; base: string; source: ScopeRoot["source"] }> = [
    { path: globalPath, base: homedir(), source: "global" },
    { path: projectPath, base: cwd, source: "project" },
  ];

  const roots: ScopeRoot[] = [{ path: canonicalize(cwd), access: "rw", source: "session" }];
  const rules: ScopeRule[] = [];
  const defaults = { ...DEFAULT_SCOPE_DEFAULTS };

  for (const file of files) {
    const parsed = readConfig(file.path, problems);
    if (!parsed) continue;
    sources.push(file.path);
    for (const root of normalizeRoots(parsed.roots, file.base, file.source, problems)) upsertRoot(roots, root);
    for (const rule of parsed.rules ?? []) {
      if (!isRule(rule)) {
        problems.push(`${file.path}: ignoring a rule without action/resource/effect`);
        continue;
      }
      rules.push({ ...rule, resource: expandRuleResource(rule.resource), source: file.source });
    }
    if (parsed.defaults?.external && isEffect(parsed.defaults.external)) defaults.external = parsed.defaults.external;
    if (parsed.defaults?.readExternal && isEffect(parsed.defaults.readExternal)) defaults.readExternal = parsed.defaults.readExternal;
    // A removed key must be reported, not silently dropped: a config that still
    // carries it is asking for a decision this gate no longer makes.
    if (parsed.defaults && "unknown" in parsed.defaults) {
      problems.push(
        `${file.path}: "defaults.unknown" was removed; Scope gates only builtin path tools, so a tool it cannot map bypasses it.`,
      );
    }
    if ("mcp" in parsed) {
      problems.push(
        `${file.path}: the "mcp" section was removed; MCP tools bypass Scope and are neither allowed nor denied here.`,
      );
    }
    if ("yolo" in parsed) {
      problems.push(`${file.path}: "yolo" is not configurable; arm it interactively with /scope yolo`);
    }
  }

  if (records) {
    for (const root of records.roots ?? []) {
      if (typeof root?.path !== "string" || !root.path) continue;
      if (isUnsafeStoredRoot(root.path, cwd)) {
        problems.push(`Ignoring a stored grant for ${root.path}: it contains the workspace or your home directory.`);
        continue;
      }
      upsertRoot(roots, { path: canonicalize(root.path), access: root.access === "ro" ? "ro" : "rw", source: "branch" });
    }
    for (const rule of records.rules ?? []) if (isRule(rule)) rules.push({ ...rule, source: "branch" });
  }

  return {
    state: { roots, rules, defaults, ...(records?.yolo ? { yolo: yoloFrom(records.yolo) } : {}) },
    sources,
    problems,
  };
}

function yoloFrom(record: { strength: ScopeAccess }): ScopeYolo {
  // `since` is re-stamped on load: the arm is honest about being a fresh session.
  return { strength: record.strength, persist: true, since: Date.now() };
}

/** A stored grant that would re-expose the workspace's parent or home is refused. */
function isUnsafeStoredRoot(path: string, cwd: string): boolean {
  const root = canonicalize(path);
  return root === "/" || root === homedir() || lexicalInside(root, canonicalize(cwd));
}

function upsertRoot(roots: ScopeRoot[], root: ScopeRoot): void {
  const existing = roots.findIndex(candidate => candidate.path === root.path);
  if (existing < 0) roots.push(root);
  else roots[existing] = root;
}

function readConfig(path: string, problems: string[]): ScopeConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as ScopeConfigFile;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (error) {
    problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isEffect(value: unknown): value is ScopeEffect {
  return value === "allow" || value === "ask" || value === "deny";
}

function isRule(value: unknown): value is ScopeRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<ScopeRule>;
  return typeof rule.action === "string" && typeof rule.resource === "string" && isEffect(rule.effect);
}

/** The last snapshot on the branch wins; a fork sees only its own ancestors. */
export function scopeRecordFromBranch(branch: readonly any[] | undefined): ScopeRecord | undefined {
  for (let index = (branch?.length ?? 0) - 1; index >= 0; index--) {
    const entry = branch![index];
    if (entry?.type === "custom" && entry.customType === SCOPE_RECORD_TYPE && entry.data && typeof entry.data === "object") {
      return entry.data as ScopeRecord;
    }
  }
  return undefined;
}

/** Full snapshot for `pi.appendEntry`: everything a resumed session must restore. */
export function scopeSnapshot(state: ScopeState): ScopeRecord {
  return {
    roots: state.roots
      .filter(root => root.source === "session" || root.source === "branch")
      .map(root => ({ path: root.path, access: root.access })),
    rules: state.rules.map(({ action, resource, effect }) => ({ action, resource, effect })),
    ...(state.yolo ? { yolo: { strength: state.yolo.strength } } : {}),
    seq: Date.now(),
  };
}

/** Default state for a session that has no config and no records yet. */
export function initialScopeState(cwd: string): ScopeState {
  return { roots: [{ path: canonicalize(cwd), access: "rw", source: "session" }], rules: [], defaults: { ...DEFAULT_SCOPE_DEFAULTS } };
}

/** Where `/scope allow --project` writes. */
export function projectScopeFile(cwd: string): string {
  return join(cwd, ".pi", "scope.json");
}

/** Where `/scope allow --global` writes. */
export function globalScopeFile(): string {
  return join(homedir(), ".pi", "agent", "scope.json");
}

/** Ensure the parent directory exists before a caller writes a config file. */
export function scopeFileDirectory(file: string): string {
  return dirname(file);
}

/** Create `<file>`'s parent directory and merge a root into an existing config. */
export function writeScopeRoot(file: string, base: string, path: string, access: ScopeAccess): void {
  const canonical = canonicalize(resolve(base, expandHome(path)));
  updateConfig(file, config => {
    const roots = Array.isArray(config.roots) ? config.roots : [];
    const exists = roots.some(entry => {
      const value = typeof entry === "string" ? entry : entry?.path;
      return typeof value === "string" && canonicalize(resolve(base, expandHome(value))) === canonical;
    });
    if (!exists) roots.push({ path: canonical, access });
    return { ...config, roots };
  });
}

/** Merge a deny/allow rule into an existing config file. */
export function writeScopeRule(file: string, rule: ScopeRule): void {
  updateConfig(file, config => {
    const rules = Array.isArray(config.rules) ? config.rules.filter(isRule) : [];
    const duplicate = rules.some(existing =>
      existing.action === rule.action && existing.resource === rule.resource && existing.effect === rule.effect);
    if (!duplicate) rules.push({ action: rule.action, resource: rule.resource, effect: rule.effect });
    return { ...config, rules };
  });
}

/**
 * Delete one rule from a config file.
 *
 * A stored resource may be written as `~/projects/*` where the session reports
 * `/home/u/projects/*`, so both the raw and the expanded form are compared — a
 * removal that only matched the session form would report success and delete
 * nothing. Returns false when nothing matched, so the caller can say so instead
 * of rewriting the file for a no-op.
 */
export function removeScopeRule(file: string, action: string, resource: string): boolean {
  const config = readConfigFile(file);
  const rules = Array.isArray(config.rules) ? config.rules.filter(isRule) : [];
  const kept = rules.filter(existing => !(existing.action === action
    && (existing.resource === resource || expandRuleResource(existing.resource) === resource)));
  if (kept.length === rules.length) return false;
  writeConfigFile(file, { ...config, rules: kept });
  return true;
}

function readConfigFile(file: string): ScopeConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ScopeConfigFile;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // A missing or broken file starts empty; `loadScopeConfig` is what reports the
    // problem, and it must not be duplicated here.
  }
  return {};
}

function writeConfigFile(file: string, config: ScopeConfigFile): void {
  mkdirSync(scopeFileDirectory(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function updateConfig(file: string, mutate: (config: ScopeConfigFile) => ScopeConfigFile): void {
  writeConfigFile(file, mutate(readConfigFile(file)));
}
