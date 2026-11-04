import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { watch, readFileSync, readdirSync, statSync, type FSWatcher } from "node:fs";
import { open, writeFile, rm, mkdtemp } from "node:fs/promises";
import { dirname, basename, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import {
  MarkdownPopup, overlayRows, popupOverlayOptions, PLAIN_THEME, type PopupTheme,
} from "../lib/popup/frame.ts";
import { PopupList } from "../lib/ui/shell.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar/sidebar-channel.ts";
import { markVolatileTail } from "../lib/cache-anchor.ts";
import { createArtifactAutocompleteProvider, expandArtifactMentions } from "../lib/artifact-mentions.ts";
import {
  ARTIFACT_TYPE, ARTIFACT_CONTEXT_TYPE, ARTIFACT_SIDECAR_PREFIX, ARTIFACT_SIDECAR_SUFFIX,
  sanitizeArtifactId, sanitizeScope,
  artifactFromRecord, recordsFromBranch, ordered,
  artifactCatalogContext, describeArtifact, artifactSidecarPath, parentArtifactsSnapshotPath,
  writeSidecarArtifact,
  formatBytes, clip, lookupArtifact, type Artifact, type ArtifactType,
  applyArtifactEdit, artifactLineCount, renderArtifactSlice, searchArtifactText, sliceArtifactContent,
} from "../lib/artifact-state.ts";
import { recordsFromBranch as childRecordsFromBranch } from "../lib/subagent-state.ts";
import { isSubagentChildProcess } from "../lib/subagent-context.ts";
import { isChildReadOnlyArtifact } from "../lib/delegation/handoff-artifact.ts";
import { DASHBOARD_SYNC_EVENT, publishDashboardArtifacts } from "../lib/dashboard/integration.ts";
import { toArtifactRecord, type DashboardArtifactRecord } from "../lib/dashboard/projection.ts";
import { stringEnum } from "../lib/schema.ts";

export async function readSidecarArtifact(filePath: string): Promise<Artifact | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    if ((await handle.stat()).size > 5 * 1024 * 1024) return; // 5MB sanity cap
    const content = await handle.readFile("utf8");
    return artifactFromRecord(JSON.parse(content));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

export async function publishChildSnapshot(
  targetDir: string,
  sessionFile: string,
  scope?: string,
  catalog?: Map<string, Artifact> | Artifact[],
): Promise<void> {
  try {
    const snapshotPath = parentArtifactsSnapshotPath(sessionFile);
    const items = Array.isArray(catalog)
      ? catalog
      : catalog
      ? [...catalog.values()]
      : [];
    const list = scope
      ? items.filter((a) => a.scope === undefined || a.scope === scope)
      : [...items];
    await writeFile(snapshotPath, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch { /* best-effort export */ }
}

export function searchArtifacts(
  artifacts: Artifact[],
  query?: string,
  typeFilter?: string,
): { matches: Artifact[]; snippets: Map<string, string> } {
  let filtered = artifacts;
  if (typeFilter && typeFilter !== "all") {
    filtered = filtered.filter(a => a.type === typeFilter);
  }

  const snippets = new Map<string, string>();
  if (!query?.trim()) {
    return { matches: filtered, snippets };
  }

  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches: Artifact[] = [];

  for (const art of filtered) {
    const haystack = `${art.id} ${art.title} ${art.tags.join(" ")} ${art.content}`.toLowerCase();
    const hits = terms.filter(t => haystack.includes(t));
    if (hits.length > 0) {
      matches.push(art);
      // Generate a snippet around first hit
      const firstHit = hits[0];
      const idx = art.content.toLowerCase().indexOf(firstHit);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(art.content.length, idx + 140);
        snippets.set(art.id, (start > 0 ? "…" : "") + art.content.slice(start, end).replace(/\s+/g, " ") + (end < art.content.length ? "…" : ""));
      }
    }
  }

  return { matches, snippets };
}

// ── Theme Adapter ──

export function adaptPopupTheme(theme?: any): PopupTheme {
  if (!theme) return PLAIN_THEME;
  return {
    fg: (token, text) => (typeof theme.fg === "function" ? theme.fg(token, text) : text),
    bold: (text) => (typeof theme.bold === "function" ? theme.bold(text) : text),
    bg: typeof theme.bg === "function" ? (token, text) => theme.bg(token, text) : undefined,
  };
}

// ── Editor Command Resolution and Launcher ──

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; shell?: boolean },
) => { on(event: "close" | "error", cb: (codeOrErr: any) => void): void };

let activeSpawnFn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts);

export function setSpawnFn(fn?: SpawnFn): void {
  activeSpawnFn = fn ?? ((cmd, args, opts) => spawn(cmd, args, opts));
}

function isExecutable(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function findInPath(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (cmd.includes("/") || (process.platform === "win32" && cmd.includes("\\"))) {
    return isExecutable(cmd) ? cmd : undefined;
  }
  const pathVal = env.PATH ?? process.env.PATH ?? "";
  const sep = delimiter;
  const dirs = pathVal.split(sep).filter(Boolean);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = join(dir, cmd + ext);
      if (isExecutable(full)) return full;
    }
  }
  return undefined;
}

function splitEditorArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) out.push(current);
  return out;
}

export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const envCmd = env.PI_EDITOR || env.VISUAL || env.EDITOR;
  if (envCmd && envCmd.trim().length > 0) {
    const parts = splitEditorArgs(envCmd.trim());
    if (parts.length) return { command: parts[0]!, args: parts.slice(1) };
  }

  // Fall back to nvim if available, else platform default (notepad on win32, nano on posix)
  if (findInPath("nvim", env)) {
    return { command: "nvim", args: [] };
  }
  return { command: process.platform === "win32" ? "notepad" : "nano", args: [] };
}

export interface OpenArtifactOptions {
  title?: string;
  id?: string;
  tui?: { stop?: () => void; start?: () => void; requestRender?: (force?: boolean) => void };
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  /** Persist changed editor content; called only after a successful exit and a real change. */
  onSave?: (content: string) => void | Promise<void>;
}

export async function openArtifactInEditor(
  content: string,
  options?: OpenArtifactOptions,
): Promise<boolean> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-artifact-"));
  const rawId = options?.id || options?.title || "artifact";
  const baseId = sanitizeArtifactId(rawId).replace(/\.md$/, "");
  const fileName = `${baseId || "artifact"}.md`;
  const filePath = join(tempDir, fileName);

  const tui = options?.tui;
  const hasTui = tui && typeof tui.stop === "function" && typeof tui.start === "function";
  let tuiStopped = false;

  try {
    await writeFile(filePath, content, "utf8");
    const { command, args } = resolveEditorCommand(options?.env ?? process.env);
    const spawnToUse = options?.spawnFn ?? activeSpawnFn;

    if (hasTui && tui?.stop) {
      try {
        tui.stop();
        tuiStopped = true;
      } catch {
        /* ignore */
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      try {
        const child = spawnToUse(command, [...args, filePath], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(typeof code === "number" ? code : null));
      } catch {
        resolve(null);
      }
    });

    if (exitCode !== 0) return false;
    if (options?.onSave) {
      const edited = readFileSync(filePath, "utf8");
      if (edited !== content) await options.onSave(edited);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (tuiStopped && tui?.start) {
      try {
        tui.start();
        if (typeof tui.requestRender === "function") {
          tui.requestRender(true);
        }
      } catch {
        /* ignore */
      }
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── Formatting Helpers ──

export function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  if (isNaN(diff) || diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function artifactTypeIcon(type: string): string {
  switch (type) {
    case "plan": return "󰏫";
    case "spec": return "󰈙";
    case "scratchpad": return "󰠮";
    case "code": return "󰅪";
    case "review": return "󰍨";
    default: return "📦";
  }
}

export function formatArtifactMarkdown(art: Artifact): string {
  const size = formatBytes(Buffer.byteLength(art.content, "utf8"));
  const tagsStr = art.tags.length ? art.tags.join(", ") : "none";
  return [
    `# [${art.id}] ${art.title}`,
    "",
    `- **ID:** \`${art.id}\``,
    `- **Type:** \`${art.type}\``,
    `- **Version:** v${art.version}`,
    `- **Tags:** ${tagsStr}`,
    `- **Created By:** ${art.createdBy}`,
    `- **Updated:** ${art.updatedAt}`,
    `- **Size:** ${size} (${Buffer.byteLength(art.content, "utf8")} bytes)`,
    "",
    "---",
    "",
    art.content,
  ].join("\n");
}

// ── Detail & Picker Popups ──

export type ArtifactSaveHandler = (
  content: string,
  current: Artifact,
) => Promise<Artifact | undefined> | Artifact | undefined | void;

export async function showArtifactDetail(
  art: Artifact,
  context: ExtensionContext,
  onSave?: ArtifactSaveHandler,
): Promise<void> {
  if (!context.hasUI || typeof context.ui.custom !== "function") return;

  let current = art;
  let markdown = formatArtifactMarkdown(current);
  let shouldReopen = true;

  while (shouldReopen) {
    shouldReopen = false;
    let tuiRef: any;
    const result = await context.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        tuiRef = tui;
        const pTheme = adaptPopupTheme(theme);
        const popup = new MarkdownPopup({
          markdown,
          theme: pTheme,
          title: `[${current.id}] ${current.title}`,
          hint: "Esc close · / search · o nvim",
          rows: 20,
          terminalRows: () => overlayRows(tuiRef?.terminal?.rows ?? 24, 90),
          onClose: (action) => done(action),
          onOpenExternal: () => true,
        });
        return popup;
      },
      { overlay: true, overlayOptions: popupOverlayOptions("86%", 50, "90%") as any },
    );

    if (result === "external") {
      await openArtifactInEditor(current.content, {
        id: current.id,
        title: current.title,
        tui: tuiRef,
        onSave: onSave
          ? async (content) => {
              const updated = await onSave(content, current);
              if (updated) {
                current = updated;
                markdown = formatArtifactMarkdown(current);
              }
            }
          : undefined,
      });
      shouldReopen = true;
    }
  }
}

export async function showArtifactPicker(
  items: Artifact[],
  context: ExtensionContext,
  onSave?: ArtifactSaveHandler,
): Promise<void> {
  if (!items.length) {
    context.ui.notify?.("No artifacts recorded on this branch. Use `artifact_save` to create one.", "info");
    return;
  }
  if (!context.hasUI || typeof context.ui.custom !== "function") return;

  while (true) {
    let chosenArtifact: Artifact | undefined;
    await context.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const pTheme = adaptPopupTheme(theme);
        const list = new PopupList<Artifact>({
          theme: pTheme,
          title: `Workspace Artifacts (${items.length})`,
          hint: "Enter open · 1-9 jump · Esc close",
          items,
          numbered: true,
          terminalRows: () => overlayRows(tui.terminal?.rows ?? 24, 80),
          renderItem: (art, { selected }) => {
            const marker = selected ? pTheme.fg("accent", "→") : " ";
            const icon = artifactTypeIcon(art.type);
            const size = formatBytes(Buffer.byteLength(art.content, "utf8"));
            const age = formatAge(art.updatedAt);
            const idPart = `[${art.id}]`;
            const meta = `v${art.version} · ${size} · ${age}`;
            return `${marker} ${icon} ${pTheme.bold(idPart)} ${art.title}  ${pTheme.fg("dim", meta)}`;
          },
          onSelect: (art) => {
            chosenArtifact = art;
            done();
          },
          onCancel: () => done(),
        });
        return list;
      },
      { overlay: true, overlayOptions: popupOverlayOptions("84%", 50, "80%") as any },
    );

    if (chosenArtifact) {
      await showArtifactDetail(chosenArtifact, context, onSave);
    } else {
      break;
    }
  }
}

export default function artifactsExtension(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let artifacts = new Map<string, Artifact>();
  const watchers = new Map<string, FSWatcher>();
  const watchedDirs = new Set<string>();
  // Child identity is verified against this process's own session file, not taken
  // from the environment alone. A plain `pi` started from a Herdr pane's shell
  // inherits `PI_SUBAGENT_*`, and used to be treated as that pane's child: it lost
  // its artifact catalog to the child loader and adopted a stale run id. Gating
  // every variable on the verified check keeps all downstream use correct at once.
  const verifiedChild = isSubagentChildProcess();
  const childSession = verifiedChild ? process.env.PI_SUBAGENT_SESSION : undefined;
  const childRun = verifiedChild ? process.env.PI_SUBAGENT_ID : undefined;
  const childName = verifiedChild ? process.env.PI_SUBAGENT_NAME : undefined;
  const childScope = verifiedChild && process.env.PI_SUBAGENT_SCOPE ? sanitizeScope(process.env.PI_SUBAGENT_SCOPE) : undefined;
  const isChild = Boolean(childSession && childRun);
  const runScopes = new Map<string, string>();
  /** Every child session file a launch result named in this process, scoped or not. */
  const launchedChildFiles = new Set<string>();
  const REMOVALS_SUFFIX = ".artifact-removals.json";
  /**
   * Last catalog signature published to the dashboard. Artifact content changes
   * always change id/version/updatedAt, so this bounds duplicate snapshots without
   * dropping a real edit or removal.
   */
  let dashboardSignature = "";

  function widget() {
    if (!ctx?.hasUI || isChild) return;
    const items = ordered(artifacts);
    if (offerSection(pi, { id: "artifacts", title: `Artifacts ${items.length}`,
      rows: items.length ? items.map(art => `󰈙 ${art.title}`) : ["None yet"], hint: "/artifacts" })) {
      ctx.ui.setWidget("artifacts", undefined);
      return;
    }
    if (!items.length) {
      ctx.ui.setWidget("artifacts", undefined);
      return;
    }
    ctx.ui.setWidget("artifacts", [
      `Workspace Artifacts (${items.length}) — /artifacts`,
      ...items.slice(0, 3).map(a => {
        const size = formatBytes(Buffer.byteLength(a.content, "utf8"));
        return `📦 [${a.id}] (${a.type}, v${a.version}, ${size}) ${clip(a.title, 60)}`;
      }),
      ...(items.length > 3 ? [`+ ${items.length - 3} more in /artifacts`] : []),
    ]);
  }

  function persistArtifact(art: Artifact) {
    artifacts.set(art.id, art);
    pi.appendEntry(ARTIFACT_TYPE, art);
    widget();
  }

  /** Save an editor round-trip through the same placement rules as artifact_edit. */
  async function saveArtifactContent(
    art: Artifact,
    content: string,
    context: ExtensionContext,
  ): Promise<Artifact | undefined> {
    if (content === art.content) return art;
    const updated: Artifact = {
      ...art,
      content,
      version: art.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await commitArtifact(updated, context);
    artifacts.set(updated.id, updated);
    widget();
    publishCatalog(context, true);
    return updated;
  }

  /**
   * The effective catalog for this session.
   *
   * This is the single source of truth for dashboard publication as well as the
   * read/edit tools. A child sees its own staged sidecars plus the scope-filtered
   * parent snapshot. A parent sees the selected branch plus sidecar-only scoped
   * specs — those are deliberately kept off the branch so a child fork cannot
   * inherit them, which means a branch-only read cannot find them, and then they
   * could never be edited at all.
   *
   * Tombstones win over sidecars. A removed artifact's sidecar can still exist on
   * disk, and merging it back because the branch no longer has the id is exactly
   * how a deleted artifact gets resurrected.
   */
  function effectiveCatalog(context: ExtensionContext): Map<string, Artifact> {
    if (isChild) return loadChildAvailableArtifacts();
    ctx = context;
    const branch = context.sessionManager.getBranch();
    const map = recordsFromBranch(branch);
    const removed = pendingRemovalIds(context);
    const sessionFile = (context.sessionManager as any).getSessionFile?.();
    if (typeof sessionFile === "string" && sessionFile) {
      for (const [id, art] of loadParentSidecars(sessionFile)) {
        if (!removed.has(id) && !map.has(id)) map.set(id, art);
      }
    }
    // Keep the module-level view in sync for `widget()`. Sidecar-only scoped specs
    // are not branch entries, so without this the sidebar would omit them.
    artifacts = map;
    return map;
  }

  /** Tools ask for the same view the dashboard publishes; keep one name for it. */
  function resolveCatalog(context: ExtensionContext): Map<string, Artifact> {
    return effectiveCatalog(context);
  }

  /** Ids removed by an in-branch tombstone. */
  function tombstonedArtifactIds(branch: readonly any[] | undefined): Set<string> {
    const ids = new Set<string>();
    for (const entry of branch ?? []) {
      if (entry?.type !== "custom" || entry.customType !== ARTIFACT_TYPE) continue;
      const raw = entry.data as any;
      if (raw && raw.deleted === true && typeof raw.id === "string") ids.add(sanitizeArtifactId(raw.id));
    }
    return ids;
  }

  /**
   * Removal intent for this session: branch tombstones plus the session removal
   * marker. The marker survives even when a transcript was compacted past the
   * tombstone entry, so a later child re-ingest cannot silently undo a removal.
   */
  function pendingRemovalIds(context: ExtensionContext): Set<string> {
    const ids = tombstonedArtifactIds(context.sessionManager.getBranch());
    if (isChild) return ids;
    const sessionFile = (context.sessionManager as any).getSessionFile?.();
    if (typeof sessionFile === "string" && sessionFile) {
      try {
        const raw = JSON.parse(readFileSync(`${sessionFile}${REMOVALS_SUFFIX}`, "utf8"));
        if (Array.isArray(raw)) {
          for (const value of raw) {
            if (typeof value !== "string") continue;
            const id = sanitizeArtifactId(value);
            if (id) ids.add(id);
          }
        }
      } catch { /* no marker */ }
    }
    return ids;
  }

  /**
   * Publish the effective catalog to the dashboard bridge.
   *
   * Observer-only: every failure is swallowed, and an unchanged catalog is not
   * republished unless the caller is answering a sync handshake.
   */
  function publishCatalog(context: ExtensionContext | undefined, force = false): void {
    if (isChild || !context) return;
    try {
      const catalog = effectiveCatalog(context);
      const records = [...catalog.values()]
        .map(toArtifactRecord)
        .filter((record): record is DashboardArtifactRecord => Boolean(record));
      const signature = records
        .map(record => `${record.id}:${record.version}:${record.updatedAt}:${record.scope ?? ""}`)
        .sort()
        .join("|");
      if (!force && signature === dashboardSignature) return;
      dashboardSignature = signature;
      publishDashboardArtifacts(pi, records);
    } catch {
      // Dashboard visibility must never interfere with the artifact tools.
    }
  }

  /**
   * Store an artifact through the single path that decides where it lives.
   *
   * Both `artifact_save` and `artifact_edit` write through here so the placement
   * rules cannot drift apart: a child always stages to its own sidecar, a scoped
   * spec in the parent is always sidecar-only, and everything else goes on the
   * branch. Duplicating this logic per tool is how an edit would end up leaking a
   * scoped spec onto the branch that children fork from.
   */
  async function commitArtifact(art: Artifact, context: ExtensionContext): Promise<{ staged: boolean; sidecarOnly: boolean }> {
    if (isChild && childSession) {
      await writeSidecarArtifact(artifactSidecarPath(childSession, art.id), art);
      return { staged: true, sidecarOnly: false };
    }
    if (art.type === "spec" && art.scope) {
      const sessionFile = (context.sessionManager as any).getSessionFile?.();
      if (typeof sessionFile === "string" && sessionFile) {
        await writeSidecarArtifact(artifactSidecarPath(sessionFile, art.id), art);
      }
      artifacts.set(art.id, art);
      widget();
      publishCatalog(context, true);
      return { staged: false, sidecarOnly: true };
    }
    persistArtifact(art);
    publishCatalog(context, true);
    return { staged: false, sidecarOnly: false };
  }

  /**
   * Session files of the children THIS session launched.
   *
   * Children write sidecars into the shared session directory, next to every
   * other session's sidecars. Ingesting the whole directory copied 26 unrelated
   * artifacts (about 244 KB) from other sessions into one parent's branch at its
   * first spawn (session 01a1a46d), inflating its context and catalog.
   */
  function knownChildSessions(): Set<string> {
    const known = new Set<string>([...runScopes.keys(), ...launchedChildFiles]);
    try {
      for (const record of childRecordsFromBranch(ctx?.sessionManager.getBranch() ?? []).values()) known.add(record.sessionFile);
    } catch { /* branch unavailable: fall back to launches seen this process */ }
    return new Set([...known].map(file => basename(file)));
  }

  async function ingestChildDirectory(dir: string): Promise<number> {
    let ingestedCount = 0;
    const ownChildren = knownChildSessions();
    // A tombstone (or the session removal marker) is final: re-ingesting the
    // child's sidecar must not bring the artifact back into the parent catalog.
    const removed = ctx ? pendingRemovalIds(ctx) : new Set<string>();
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.includes(ARTIFACT_SIDECAR_PREFIX) && file.endsWith(ARTIFACT_SIDECAR_SUFFIX)) {
          const owner = file.slice(0, file.indexOf(ARTIFACT_SIDECAR_PREFIX));
          if (!ownChildren.has(owner)) continue;
          const fullPath = `${dir}/${file}`;
          const art = await readSidecarArtifact(fullPath);
          if (art) {
            if (removed.has(art.id)) continue;
            const childSessionFile = art.sourceSession;
            if (childSessionFile && runScopes.has(childSessionFile)) {
              art.scope ??= runScopes.get(childSessionFile);
            }
            const existing = artifacts.get(art.id);
            if (!existing || existing.version < art.version || existing.updatedAt < art.updatedAt) {
              persistArtifact(art);
              ingestedCount++;
              if (ctx?.hasUI) {
                ctx.ui.notify(`📦 Artifact [${art.id}] "${clip(art.title, 40)}" staged from subagent`, "info");
              }
            }
          }
        }
      }
    } catch { /* directory might not exist yet */ }
    if (ingestedCount) publishCatalog(ctx, true);
    return ingestedCount;
  }

  function attachDirectoryWatcher(dir: string) {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(dir, (_event, filename) => {
        const fname = filename?.toString();
        if (!fname || fname.includes(ARTIFACT_SIDECAR_PREFIX)) {
          void ingestChildDirectory(dir).catch(() => {});
        }
      });
      watcher.unref?.();
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
      watchedDirs.add(dir);
    } catch { /* will retry */ }
  }

  function closeWatchers() {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    watchedDirs.clear();
  }

  function loadParentSidecars(sessionFile: string): Map<string, Artifact> {
    const map = new Map<string, Artifact>();
    try {
      const dir = dirname(sessionFile);
      const prefix = basename(sessionFile) + ARTIFACT_SIDECAR_PREFIX;
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(prefix) && file.endsWith(ARTIFACT_SIDECAR_SUFFIX)) {
          try {
            const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
            const art = artifactFromRecord(raw);
            if (art) map.set(art.id, art);
          } catch {}
        }
      }
    } catch {}
    return map;
  }

  function restore(context: ExtensionContext) {
    closeWatchers();
    ctx = context;
    applyPendingRemovals(context);
    // A child's catalog is its own staged sidecars plus the parent snapshot it was
    // given. Replaying the inherited branch would adopt the parent's artifacts as
    // this child's and, worse, publish the grandparent's catalog as the parent
    // snapshot for any worker this child spawns.
    artifacts = effectiveCatalog(context);
    widget();
    publishCatalog(context, true);
  }

  // A session-scoped `<sessionFile>.artifact-removals.json` marker (a JSON array
  // of ids) records catalog-removal intent. It is re-applied whenever anything in
  // it matches the current branch, so a later child re-ingest cannot silently
  // resurrect a removed id; absent ids are skipped, making repeat runs a no-op.
  // Appended entries travel the harness's own appendEntry path, keeping the
  // in-memory entry index and the on-disk file consistent.

  function applyPendingRemovals(context: ExtensionContext): number {
    if (isChild) return 0;
    const sessionFile = (context.sessionManager as any).getSessionFile?.();
    if (typeof sessionFile !== "string" || !sessionFile) return 0;
    let ids: unknown;
    try {
      ids = JSON.parse(readFileSync(`${sessionFile}${REMOVALS_SUFFIX}`, "utf8"));
    } catch {
      return 0;
    }
    if (!Array.isArray(ids) || !ids.length) return 0;
    const current = recordsFromBranch(context.sessionManager.getBranch());
    let removed = 0;
    for (const raw of ids) {
      if (typeof raw !== "string") continue;
      const id = sanitizeArtifactId(raw);
      if (!id || !current.has(id)) continue;
      pi.appendEntry(ARTIFACT_TYPE, { id, deleted: true, removedAt: new Date().toISOString() });
      removed++;
    }
    if (removed && context.hasUI) {
      context.ui.notify(`Removed ${removed} test artifact${removed === 1 ? "" : "s"} from the catalog.`, "info");
    }
    return removed;
  }

  // ── Child-side Artifact Loader ──
  function loadChildAvailableArtifacts(): Map<string, Artifact> {
    const map = new Map<string, Artifact>();
    if (!childSession) return map;
    const dir = dirname(childSession);

    // 1. Read parent snapshot if present
    const parentSnap = parentArtifactsSnapshotPath(childSession);
    try {
      const content = readFileSync(parentSnap, "utf8");
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          const art = artifactFromRecord(item);
          if (art) {
            // Belt: drop any record whose scope is set and != childScope
            if (art.scope !== undefined && art.scope !== childScope) continue;
            map.set(art.id, art);
          }
        }
      }
    } catch { /* no snapshot */ }

    // 2. Read local staged sidecars (they override parent snapshot)
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(basename(childSession) + ARTIFACT_SIDECAR_PREFIX) && file.endsWith(ARTIFACT_SIDECAR_SUFFIX)) {
          try {
            const raw = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
            const art = artifactFromRecord(raw);
            if (art) {
              if (art.scope !== undefined && art.scope !== childScope) continue;
              map.set(art.id, art);
            }
          } catch {}
        }
      }
    } catch {}

    return map;
  }

  function availableArtifacts(context: ExtensionContext): Map<string, Artifact> {
    return isChild ? loadChildAvailableArtifacts() : recordsFromBranch(context.sessionManager.getBranch());
  }

  // ── Lifecycle Hooks ──
  pi.events?.on(REFRESH_EVENT, widget);
  // Dashboard handshake: republish the effective catalog even if unchanged, so a
  // publisher loaded after the last mutation still contributes its initial state.
  pi.events?.on(DASHBOARD_SYNC_EVENT, () => publishCatalog(ctx, true));

  pi.on("session_start", (_event, context) => {
    restore(context);
    if (context.mode === "tui") {
      context.ui.addAutocompleteProvider(current => createArtifactAutocompleteProvider(
        current, () => ctx ? availableArtifacts(ctx) : new Map(),
      ));
    }
  });

  pi.on("input", (event, context) => {
    if (!event.text.includes("@artifact:")) return { action: "continue" };
    const text = expandArtifactMentions(event.text, availableArtifacts(context));
    if (text !== undefined) return { action: "transform", text, images: event.images };
    return { action: "continue" };
  });

  pi.on("session_tree", (_event, context) => {
    restore(context);
  });

  pi.on("session_shutdown", () => {
    closeWatchers();
    ctx?.ui.setWidget("artifacts", undefined);
    ctx = undefined;
  });

  pi.on("tool_execution_end", async (event, context) => {
    ctx = context;
    if (!event.isError && ["agent_spawn", "agent_resume"].includes(event.toolName)) {
      const d = event.result?.details;
      const file = d?.sessionFile ?? d?.sessionPath;
      const scope = d?.scope ? sanitizeScope(d.scope) : undefined;
      if (typeof file === "string") {
        launchedChildFiles.add(file);
        if (scope) runScopes.set(file, scope);
        const dir = dirname(file);
        attachDirectoryWatcher(dir);
        await publishChildSnapshot(dir, file, scope, artifacts);
        await ingestChildDirectory(dir);
        publishCatalog(context, true);
      }
    }
  });

  pi.on("message_end", async (event, context) => {
    ctx = context;
    const message = event.message;
    if (message.role === "custom" && (message.customType === "subagent_result" || message.customType === "subagent_ping")) {
      const file = (message.details as any)?.sessionFile ?? (message.details as any)?.sessionPath;
      if (typeof file === "string") {
        await ingestChildDirectory(dirname(file));
        publishCatalog(context, true);
      }
    }
  });

  // Inject compact artifact catalog into prompt context
  pi.on("context", async (event, context) => {
    ctx = context;
    if (!isChild) {
      artifacts = effectiveCatalog(context);
      publishCatalog(context);
      const catalog = artifactCatalogContext(artifacts, 8000, { isChild, childScope });
      const messages = event.messages.filter(m => !(m.role === "custom" && m.customType === ARTIFACT_CONTEXT_TYPE));
      if (catalog) {
        messages.push({
          role: "custom",
          customType: ARTIFACT_CONTEXT_TYPE,
          content: markVolatileTail(catalog),
          display: false,
          timestamp: Date.now(),
        });
      }
      return { messages };
    }
    return undefined;
  });

  if (isChild) {
    pi.on("before_agent_start", () => ({
      message: {
        customType: "artifact-subagent-guidance",
        display: false,
        content: childScope
          ? `Your scope is '${childScope}'. Only your scope and global artifacts are available; do not attempt to discover others. Save complex plans, specifications, scratchpads, or schemas via artifact_save so they are preserved and added to the main conversation. Use artifact_recall to view existing project artifacts, and artifact_recall with offset/limit to read only part of a long one. Use artifact_search to find where a string appears inside an artifact, and artifact_edit to change part of one instead of re-saving the whole document through artifact_save.`
          : "You have access to artifact_save, artifact_recall, artifact_edit and artifact_search. Save complex plans, specifications, scratchpads, or schemas via artifact_save so they are preserved and added to the main conversation. Read a long artifact by line range with artifact_recall offset/limit rather than pulling the whole document, locate text inside one with artifact_search, and change part of one with artifact_edit instead of re-saving it in full.",
      },
    }));
  }

  // ── Register Model Tools ──

  pi.registerTool({
    name: "artifact_save",
    label: "Save Artifact",
    executionMode: "sequential",
    description:
      "Create or update a persistent workspace artifact (plan, spec, scratchpad, code, review). " +
      "Artifacts created by subagents are automatically delivered to the main conversation. " +
      "Use this to store detailed specs, architecture plans, and scratch notes instead of bloating prompt history.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Unique slug identifier (e.g. 'auth-spec', 'migration-plan', 'debug-scratch')" }),
      title: Type.String({ minLength: 1, maxLength: 200, description: "Descriptive human-readable title" }),
      type: stringEnum(["plan", "spec", "scratchpad", "code", "review", "other"], { description: "Artifact category" }),
      content: Type.String({ minLength: 1, description: "The full artifact markdown/code/text content" }),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { description: "Optional tags for search/categorization" })),
      scope: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Optional work scope for isolation. Scoped specs are isolated to that work unit." })),
    }),
    async execute(_id, input, _signal, _update, context) {
      const artId = sanitizeArtifactId(input.id);
      const now = new Date().toISOString();
      const scopeInput = sanitizeScope((input as any).scope);
      const catalog = resolveCatalog(context);

      if (isChild) {
        // The handoff is FROZEN for the child. It is the document the parent
        // judges the result against, and a rework re-reads it as the contract
        // that did not change; letting the child rewrite it would let it move
        // the target it is measured by. The refusal lives here, in the artifact
        // layer, because a prompt is a request and this must be a rule.
        if (isChildReadOnlyArtifact(artId)) {
          throw new Error(
            `Refused: [${artId}] is the handoff you were given and it is read-only. `
            + `If it is wrong, report that with agent_ping and let the parent re-author it.`,
          );
        }
        const existing = catalog.get(artId);
        const version = existing ? existing.version + 1 : 1;
        const art: Artifact = {
          id: artId,
          title: input.title.trim(),
          type: input.type as ArtifactType,
          content: input.content,
          version,
          createdBy: `subagent:${childName || "agent"}:${childRun}`,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          tags: input.tags ?? existing?.tags ?? [],
          sourceSession: childSession,
          // Scope is forced from childScope, ignoring any model-supplied value
          ...(childScope ? { scope: childScope } : {}),
        };
        const placement = await commitArtifact(art, context);
        return {
          content: [{
            type: "text",
            text: `Artifact [${art.id}] "${art.title}" (v${art.version}, ${art.type}) saved. It has been staged and delivered to the main conversation.`,
          }],
          details: { id: art.id, version: art.version, staged: placement.staged, ...(art.scope ? { scope: art.scope } : {}) },
        };
      }

      // Main session
      const existing = catalog.get(artId);
      const version = existing ? existing.version + 1 : 1;
      const art: Artifact = {
        id: artId,
        title: input.title.trim(),
        type: input.type as ArtifactType,
        content: input.content,
        version,
        createdBy: "main",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tags: input.tags ?? existing?.tags ?? [],
        ...(scopeInput ? { scope: scopeInput } : (existing?.scope ? { scope: existing.scope } : {})),
      };

      // commitArtifact decides placement: a scoped spec stays sidecar-only (never
      // appendEntry) to make fork safe and keep the branch clean.
      const placement = await commitArtifact(art, context);
      if (placement.sidecarOnly) {
        return {
          content: [{
            type: "text",
            text: `Scoped spec [${art.id}] "${art.title}" (scope: ${art.scope}) saved sidecar-only. Isolated from branch entries to protect child fork isolation.`,
          }],
          details: { id: art.id, version: art.version, scope: art.scope, sidecarOnly: true },
        };
      }

      return {
        content: [{
          type: "text",
          text: `Artifact [${art.id}] "${art.title}" saved (v${art.version}, ${art.type}). Added to the workspace catalog.`,
        }],
        details: { id: art.id, version: art.version, saved: true, ...(art.scope ? { scope: art.scope } : {}) },
      };
    },
  });

  pi.registerTool({
    name: "artifact_recall",
    label: "Recall Artifact",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Retrieve artifact content by id, or search across workspace artifacts by query or category type. " +
      "For a long artifact, pass `offset`/`limit` to read only a line range instead of the whole document " +
      "(lines are 1-based and the returned gutter shows each line number). " +
      "Use this to inspect specs, implementation plans, or scratchpads without keeping them in constant prompt context.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Specific artifact ID to recall" })),
      query: Type.Optional(Type.String({ description: "Search query across titles, tags, and content" })),
      type: Type.Optional(stringEnum(["plan", "spec", "scratchpad", "code", "review", "other", "all"], { description: "Filter by artifact category" })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based first line to return. Omit to read from the start." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to return from `offset`. Omit to read to the end." })),
      lineNumbers: Type.Optional(Type.Boolean({ description: "Include the `NNN│ ` line-number gutter (default true). Set false when copying exact text into artifact_edit `oldString`." })),
    }),
    async execute(_id, input, _signal, _update, context) {
      const activeMap = resolveCatalog(context);

      if (input.id) {
        const rawId = input.id.trim();
        const art = lookupArtifact(rawId, activeMap);
        if (!art) {
          const available = [...activeMap.keys()].join(", ") || "none";
          throw new Error(`Artifact [${rawId}] not found. Available artifacts: ${available}`);
        }
        const wantsRange = input.offset !== undefined || input.limit !== undefined;
        if (!wantsRange) {
          return {
            content: [{ type: "text", text: describeArtifact(art, true) }],
            details: { id: art.id, version: art.version, size: art.content.length },
          };
        }

        const slice = sliceArtifactContent(art.content, input.offset ?? 1, input.limit);
        const header = describeArtifact(art, false);
        // An offset past the end is a caller mistake, not an empty artifact. Say so
        // plainly instead of rendering a confusing "lines 6-5 of 5" range.
        if (!slice.lines.length) {
          return {
            content: [{
              type: "text",
              text: `${header}\n\nNo lines in the requested range: the artifact has ${slice.totalLines} line(s), and offset ${input.offset ?? 1} is past the end. Read from offset 1.`,
            }],
            details: { id: art.id, version: art.version, startLine: slice.startLine, endLine: slice.endLine, totalLines: slice.totalLines, empty: true },
          };
        }
        const nav: string[] = [
          `Lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}.`,
        ];
        if (slice.hasBefore) nav.push(`Earlier lines: artifact_recall({ id: "${art.id}", offset: 1, limit: ${slice.startLine - 1} })`);
        if (slice.hasAfter) nav.push(`Later lines: artifact_recall({ id: "${art.id}", offset: ${slice.endLine + 1} })`);
        const body = renderArtifactSlice(slice, { lineNumbers: input.lineNumbers !== false });
        return {
          content: [{ type: "text", text: `${header}\n\n${nav.join("\n")}\n\n${body}` }],
          details: {
            id: art.id,
            version: art.version,
            size: art.content.length,
            startLine: slice.startLine,
            endLine: slice.endLine,
            totalLines: slice.totalLines,
            truncated: slice.hasBefore || slice.hasAfter,
          },
        };
      }

      const allArtifacts = ordered(activeMap);
      if (!allArtifacts.length) {
        return {
          content: [{ type: "text", text: "No workspace artifacts recorded on this branch yet. Use `artifact_save` to create one." }],
          details: { count: 0 },
        };
      }

      const { matches, snippets } = searchArtifacts(allArtifacts, input.query, input.type);
      if (!matches.length) {
        return {
          content: [{ type: "text", text: `No artifacts matched query: "${input.query || ""}" (type: ${input.type || "all"}).\nFor a line-and-column hit inside artifact bodies, use artifact_search.` }],
          details: { count: 0 },
        };
      }

      const lines = [
        `Found ${matches.length} matching artifact(s):`,
        ...matches.map(a => {
          const size = formatBytes(Buffer.byteLength(a.content, "utf8"));
          const snippet = snippets.get(a.id);
          const snippetLine = snippet ? `\n    Snippet: "${snippet}"` : "";
          return `- [${a.id}] (${a.type}, v${a.version}, ${size}) "${a.title}"${snippetLine}`;
        }),
        "\nUse `artifact_recall({ id: '<id>' })` to view content, or `artifact_search` to locate a line inside it.",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: matches.length },
      };
    },
  });

  pi.registerTool({
    name: "artifact_list",
    label: "List Artifacts",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: "List all active workspace artifacts, their categories, versions, authors, and sizes.",
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, context) {
      let activeMap: Map<string, Artifact>;
      if (isChild) {
        activeMap = loadChildAvailableArtifacts();
      } else {
        ctx = context;
        activeMap = recordsFromBranch(context.sessionManager.getBranch());
      }

      const items = ordered(activeMap);
      if (!items.length) {
        return {
          content: [{ type: "text", text: "No artifacts recorded on this branch." }],
          details: { count: 0 },
        };
      }

      const text = [
        `Active Workspace Artifacts (${items.length}):`,
        ...items.map(a => describeArtifact(a, false)),
        "\nUse `artifact_recall({ id: '<id>' })` to view content, `artifact_search` to locate text inside one, or `artifact_edit` to change part of one.",
      ].join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { count: items.length },
      };
    },
  });

  pi.registerTool({
    name: "artifact_edit",
    label: "Edit Artifact",
    executionMode: "sequential",
    description:
      "Change PART of an existing artifact without rewriting the whole document. " +
      "Use this instead of re-saving a long artifact with small changes: `artifact_save` replaces the entire content, " +
      "so using it to fix one line forces you to reproduce every other line exactly. " +
      "Modes: `append` (add to the end), `replace` (swap an exact substring — the safe default), " +
      "`insert` (add lines before/after a given line), `replaceLines` (swap a 1-based line range). " +
      "Line numbers are 1-based and match the gutter returned by `artifact_recall({ offset, limit })`. " +
      "Each edit bumps the version and preserves scope and author placement rules.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, description: "Artifact ID to edit" }),
      mode: stringEnum(["append", "replace", "insert", "replaceLines"], { description: "How to apply the change" }),
      content: Type.Optional(Type.String({ description: "New text block. Required for append, insert and replaceLines." })),
      oldString: Type.Optional(Type.String({ description: "[replace] Exact existing text to find. Must match exactly, including whitespace." })),
      newString: Type.Optional(Type.String({ description: "[replace] Replacement text. Use \"\" to delete the match." })),
      occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "[replace] Which occurrence of oldString to replace when it appears more than once (default 1)." })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "[insert] 1-based anchor line." })),
      where: Type.Optional(stringEnum(["before", "after"], { description: "[insert] Place the block before or after the anchor line (default after)." })),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "[replaceLines] 1-based first line of the range to replace." })),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: "[replaceLines] 1-based last line of the range to replace (default: startLine)." })),
      title: Type.Optional(Type.String({ maxLength: 200, description: "Optionally update the title in the same edit." })),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { description: "Optionally replace the tags in the same edit." })),
    }),
    async execute(_id, input, _signal, _update, context) {
      const catalog = resolveCatalog(context);
      const art = lookupArtifact(input.id.trim(), catalog);
      if (!art) {
        const available = [...catalog.keys()].join(", ") || "none";
        throw new Error(`Artifact [${input.id}] not found. Available artifacts: ${available}`);
      }
      if (isChild && isChildReadOnlyArtifact(art.id)) {
        throw new Error(
          `Refused: [${art.id}] is the handoff you were given and it is read-only. `
          + `If it is wrong, report that with agent_ping and let the parent re-author it.`,
        );
      }

      const { content, summary } = applyArtifactEdit(art.content, {
        mode: input.mode as any,
        content: (input as any).content,
        oldString: (input as any).oldString,
        newString: (input as any).newString,
        occurrence: (input as any).occurrence,
        line: (input as any).line,
        where: (input as any).where,
        startLine: (input as any).startLine,
        endLine: (input as any).endLine,
      });
      // A no-op edit would still bump the version, which makes the history lie.
      if (content === art.content) {
        throw new Error("artifact_edit: the edit changed nothing, so no version was recorded.");
      }

      const now = new Date().toISOString();
      const next: Artifact = {
        ...art,
        content,
        version: art.version + 1,
        updatedAt: now,
        title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : art.title,
        tags: input.tags ?? art.tags,
      };
      const placement = await commitArtifact(next, context);

      const where = placement.staged
        ? "staged for the main conversation"
        : placement.sidecarOnly
        ? `saved sidecar-only (scoped spec, scope: ${next.scope})`
        : "committed to the workspace catalog";
      return {
        content: [{
          type: "text",
          text: `Artifact [${next.id}] "${next.title}" edited (v${next.version}, ${artifactLineCount(next.content)} lines). ${summary} ${where}.`,
        }],
        details: {
          id: next.id,
          version: next.version,
          mode: input.mode,
          staged: placement.staged,
          sidecarOnly: placement.sidecarOnly,
          startLine: input.startLine,
          endLine: input.endLine,
          line: input.line,
          lines: artifactLineCount(next.content),
          ...(next.scope ? { scope: next.scope } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "artifact_search",
    label: "Search Artifact Text",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Find where a string appears INSIDE artifact bodies and report artifact, line and column for each hit. " +
      "Use this to locate a passage before reading or editing it, so you can pass a precise `offset`/`limit` to " +
      "`artifact_recall` or a precise `startLine` to `artifact_edit` instead of pulling the whole document. " +
      "Unlike `artifact_recall({ query })`, which only lists matching artifacts, this returns the positions. " +
      "Search is case-insensitive literal text by default; set `regex: true` for a pattern.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Text or pattern to find inside artifact content" }),
      id: Type.Optional(Type.String({ description: "Restrict the search to one artifact" })),
      type: Type.Optional(stringEnum(["plan", "spec", "scratchpad", "code", "review", "other", "all"], { description: "Restrict the search to one artifact category" })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Match case exactly (default false)" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat `query` as a regular expression (default false: literal text)" })),
      contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Lines of context to show around each hit (default 1)" })),
      maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Cap on returned matches (default 40)" })),
    }),
    async execute(_id, input, _signal, _update, context) {
      const catalog = resolveCatalog(context);
      let scope: Artifact[];
      if (input.id) {
        const art = lookupArtifact(input.id.trim(), catalog);
        if (!art) {
          const available = [...catalog.keys()].join(", ") || "none";
          throw new Error(`Artifact [${input.id}] not found. Available artifacts: ${available}`);
        }
        scope = [art];
      } else {
        scope = ordered(catalog);
      }

      if (!scope.length) {
        return {
          content: [{ type: "text", text: "No artifacts to search. Use `artifact_save` to create one." }],
          details: { count: 0 },
        };
      }

      const { matches, truncated, artifactsSearched } = searchArtifactText(scope, input.query, {
        type: input.type,
        caseSensitive: input.caseSensitive,
        regex: input.regex,
        contextLines: input.contextLines,
        maxMatches: input.maxMatches,
      });

      if (!matches.length) {
        return {
          content: [{
            type: "text",
            text: `No matches for ${input.regex ? "pattern" : "text"} "${input.query}" in ${artifactsSearched} artifact(s)` +
              `${input.id ? ` (searched ${input.id} only)` : ""}.`,
          }],
          details: { count: 0, artifactsSearched },
        };
      }

      const rendered = matches.map(match => {
        const gutter = (n: number) => `${String(n).padStart(3)}│`;
        const totalLines = artifactLineCount(catalog.get(match.artifactId)?.content ?? "");
        const block: string[] = [
          `[${match.artifactId}] "${match.artifactTitle}" — line ${match.line} of ${totalLines}, col ${match.column}`,
          ...match.before.map((text, index) => `${gutter(match.line - match.before.length + index)} ${text}`),
          `${gutter(match.line)} ${match.text}`,
          ...match.after.map((text, index) => `${gutter(match.line + 1 + index)} ${text}`),
          `   → read: artifact_recall({ id: "${match.artifactId}", offset: ${match.line}, limit: ${Math.max(1, match.after.length + 2)} })`,
        ];
        return block.join("\n");
      });

      const header = `Found ${matches.length} match(es) in ${new Set(matches.map(m => m.artifactId)).size} artifact(s)` +
        (truncated ? ` — TRUNCATED at maxMatches; narrow the query or raise maxMatches` : "");

      return {
        content: [{ type: "text", text: [header, "", ...rendered].join("\n") }],
        details: {
          count: matches.length,
          artifactsSearched,
          truncated,
          hits: matches.map(m => ({ id: m.artifactId, line: m.line, column: m.column })),
        },
      };
    },
  });

  // ── Register Interactive Command and Event Listeners ──

  pi.events?.on("artifacts:open", async (payload: any) => {
    if (!ctx || !payload?.id) return;
    // availableArtifacts() keeps a child on its own staged catalog + parent
    // snapshot instead of adopting the inherited parent branch.
    artifacts = availableArtifacts(ctx);
    const art = lookupArtifact(payload.id, artifacts);
    if (art) {
      await showArtifactDetail(art, ctx, (content) => saveArtifactContent(art, content, ctx!));
    } else {
      ctx.ui?.notify?.(`Artifact [${payload.id}] not found on active branch.`, "warning");
    }
  });

  pi.events?.on("artifacts:open-dialog", async () => {
    if (!ctx) return;
    artifacts = availableArtifacts(ctx);
    const items = ordered(artifacts);
    await showArtifactPicker(items, ctx, (content, art) => saveArtifactContent(art, content, ctx!));
  });

  pi.registerCommand("artifacts", {
    description: "Browse, view, and inspect workspace artifacts in a modal viewer.",
    handler: async (_args, context) => {
      if (!context.hasUI) return;
      ctx = context;
      applyPendingRemovals(context);
      artifacts = availableArtifacts(context);
      const items = ordered(artifacts);

      if (!items.length) {
        context.ui.notify("No artifacts recorded on this branch. Use `artifact_save` to create one.", "info");
        return;
      }

      if (typeof context.ui.custom === "function") {
        await showArtifactPicker(items, context, (content, art) => saveArtifactContent(art, content, context));
        return;
      }

      const options = items.map((a, i) => {
        const size = formatBytes(Buffer.byteLength(a.content, "utf8"));
        return `${i + 1}. [${a.id}] (${a.type}, v${a.version}, ${size}) — ${clip(a.title, 60)}`;
      });

      const selected = await context.ui.select("Workspace Artifacts", options);
      const index = options.indexOf(selected ?? "");
      if (index < 0) return;

      const art = items[index];
      await context.ui.editor(`Artifact: [${art.id}] "${art.title}" (v${art.version})`, describeArtifact(art, true));
    },
  });
}
