import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  PopupPanel,
  popupOverlayOptions,
  popupHeight,
  isPopupCloseKey,
  type PopupRow,
} from "../lib/popup/frame.ts";
import { PopupList } from "../lib/ui/shell.ts";
import { watch, readFileSync, existsSync, statSync, type FSWatcher } from "node:fs";
import { open, rename, writeFile, rm } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CHECKPOINT_TYPE, CONTEXT_TYPE, PROGRESS_SUFFIX, applyMilestone, checkpointContext,
  clip, describe, launched, milestoneOf, ordered, outcome, recordsFromBranch, stateLabel, subagentStatusIcon, textOf,
  type ChildRecord, type Milestone,
} from "../lib/subagent-state.ts";
import { contextModeLabel } from "../lib/subagent-context.ts";
import { offerSection } from "../lib/sidebar/sidebar-channel.ts";
import { isTodoTool } from "../lib/todo-tools.ts";
import { SUBAGENT_DETAILS_HINT } from "../lib/workflow-actions.ts";
import { compileSubagentSession, recallSubagentHistory } from "../lib/vcc-subagent-adapter.ts";
import {
  PARENT_BRIEF_TYPE,
  boundPull,
  defaultNewerThanSeed,
  parentPullHeader,
  resolveParentContext,
} from "../lib/parent-context.ts";
import { childContextState, isSubagentChildProcess, isSubagentChildSession, ownEntries } from "../lib/subagent-context.ts";
import {
  describeRetention,
  retentionCandidates,
} from "../lib/subagent-retention.ts";
import {
  parseSubagentsCommand,
  isSwitchCommand,
  getDelegationStatus,
  formatDelegationStatus,
  applyDelegationToggle,
  saveDelegationDefault,
  DELEGATE_SWITCH_TYPE,
  switchStateFromBranch,
} from "../lib/delegation-switch.ts";
import { delegationTool } from "../lib/delegation-tools.ts";

/** Digest briefs are a starting point, not a transcript dump. */
const PARENT_BRIEF_MAX_CHARS = 12_000;

export async function readMilestone(sessionFile: string): Promise<Milestone | undefined> {
  let handle;
  try {
    handle = await open(sessionFile + PROGRESS_SUFFIX, "r");
    if ((await handle.stat()).size > 32000) return;
    return milestoneOf(JSON.parse(await handle.readFile("utf8")));
  } catch { return; } finally { await handle?.close(); }
}

export async function writeMilestone(milestone: Milestone): Promise<void> {
  const target = milestone.sessionFile + PROGRESS_SUFFIX;
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(milestone), { mode: 0o600 });
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}

export function transcriptPreview(sessionFile: string): string {
  // On-demand only. Use the active child branch, never all abandoned alternatives.
  if (statSync(sessionFile).size > 16 * 1024 * 1024) throw new Error("Session exceeds the 16 MiB preview limit; reopen it directly instead.");
  const fileEntries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
  const header = fileEntries.find(e => e.type === "session");
  if (!header) throw new Error("Saved child has no valid session header yet.");
  // SessionManager.open can initialize/rewrite an empty file. In-memory loading is strictly read-only.
  const entries = SessionManager.inMemory(header.cwd, undefined, fileEntries).getBranch();
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role !== "system") {
      const msg = entry.message;
      const text = "content" in msg ? textOf(msg.content) : "";
      const tools = msg.role === "assistant" ? msg.content.filter(p => p.type === "toolCall").map(p => `Tool: ${p.name}`).join("\n") : "";
      if (text || tools) lines.push(`[${msg.role}]\n${clip(text, 2000)}${tools ? "\n" + tools : ""}`);
    } else if (entry.type === "custom_message") {
      lines.push(`[${entry.customType}]\n${clip(textOf(entry.content), 2000)}`);
    }
  }
  return `Saved child transcript preview — active branch, last 40 text/tool entries; thinking omitted.\nSession: ${sessionFile}\n\n${lines.slice(-40).join("\n\n").slice(-30000)}`;
}

export default function subagentCheckpoints(pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let records = new Map<string, ChildRecord>();
  // Only launches observed by this runtime are known to retain Herdr's completion watcher.
  const observed = new Set<string>();
  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const launchInputs = new Map<string, any>();
  let generation = 0;
  let childRevision = "";
  let childQueue = Promise.resolve();
  // Verified against this process's own session file: an inherited
  // `PI_SUBAGENT_SESSION` from a Herdr pane's shell must not turn a normal `pi`
  // into that pane's child, which registered the child progress tool and injected the
  // parent-pull guidance into an unrelated session.
  const verifiedChild = isSubagentChildProcess();
  const childSession = verifiedChild ? process.env.PI_SUBAGENT_SESSION : undefined;
  const childRun = verifiedChild ? process.env.PI_SUBAGENT_ID : undefined;
  // Resolved once: the parent pointer is fixed for the life of this process, and
  // resolving it needs a synchronous read of the child's own seed record.
  //
  // A spec-only reviewer never resolves one. Its whole value is that it judges a
  // document without the author's reasoning, so the pull channel (`agent_parent_recall`,
  // `agent_parent_digest`) and the digest brief are not registered and not injected.
  // Absence, not instruction, is what makes that hold.
  const specOnlyReviewer = process.env.PI_SUBAGENT_REVIEW_POLICY === "spec-only";
  const parentContext = childSession && !specOnlyReviewer ? resolveParentContext(childSession) : undefined;
  // A digest child is promised a parent brief but seeds an empty transcript, so
  // the brief is compiled lazily and cached for the process.
  let parentBrief: string | undefined;
  let parentBriefCompiled = false;
  async function ensureParentBrief(): Promise<string | undefined> {
    if (!parentContext || parentContext.provenance?.mode !== "digest" || parentBriefCompiled) return parentBrief;
    parentBriefCompiled = true;
    try {
      const compiled = await compileSubagentSession(parentContext.sessionFile);
      if (compiled) parentBrief = clip(compiled, PARENT_BRIEF_MAX_CHARS);
    } catch { /* fall back to no brief; agent_parent_recall still works */ }
    return parentBrief;
  }

  function widget() {
    if (!ctx?.hasUI) return;
    const rows = ordered(records);
    if (!rows.length) {
      offerSection(pi, { id: "subagents", title: "Delegated work", rows: [], hint: "/subagents" });
      ctx.ui.setWidget("subagent-checkpoints", undefined);
      return;
    }
    const activeCount = rows.filter(r => r.status === "running" || r.status === "blocked").length;
    const sidebarRows = rows.map(r => {
      const unverified = stateLabel(r, observed.has(r.sessionFile)).startsWith("unverified");
      const icon = subagentStatusIcon(r.status, unverified);
      const state = unverified ? "unverified" : r.status;
      // Surface how the child was seeded: a fork carries inherited tokens, a
      // digest carries a brief, a fresh child carries nothing.
      const mode = r.context ? ` · ${contextModeLabel(r.context)}` : "";
      return `${icon} ${r.name} · ${state}${mode}`;
    });
    const hint = SUBAGENT_DETAILS_HINT;

    // First offer to the right sidebar:
    if (offerSection(pi, {
      id: "subagents",
      title: `Delegated (${rows.length})`,
      tone: activeCount > 0 ? "accent" : undefined,
      rows: sidebarRows,
      hint,
    })) {
      // Sidebar handled it: clear the widget above prompt input completely!
      ctx.ui.setWidget("subagent-checkpoints", undefined);
      return;
    }

    // Sidebar absent: fallback widget above prompt input.
    // If no active subagents are running/blocked, hide widget to avoid obscuring conversation!
    if (activeCount === 0) {
      ctx.ui.setWidget("subagent-checkpoints", undefined);
      return;
    }
    // Only 1 compact line for active subagents!
    const activeSummary = rows
      .filter(r => r.status === "running" || r.status === "blocked")
      .map(r => `${subagentStatusIcon(r.status)} ${r.name} (${r.status})`)
      .join(", ");
    ctx.ui.setWidget("subagent-checkpoints", [
      clip(`Delegated: ${activeSummary} · ${SUBAGENT_DETAILS_HINT} · /subagents`, 120),
    ]);
  }
  function persist(record: ChildRecord) {
    records.set(record.sessionFile, record);
    pi.appendEntry(CHECKPOINT_TYPE, record);
    widget();
  }
  function ingest(sessionFile: string): Promise<void> {
    const existing = pending.get(sessionFile);
    if (existing) { dirty.add(sessionFile); return existing; }
    const currentGeneration = generation;
    const work = (async () => {
      do {
        dirty.delete(sessionFile);
        const milestone = await readMilestone(sessionFile);
        if (currentGeneration !== generation) return;
        const previous = records.get(sessionFile);
        if (previous && milestone) {
          const next = applyMilestone(previous, milestone);
          if (next !== previous) {
            persist(next);
            // Native UI only: no unsolicited model turns or token-spending progress polling.
            if (ctx?.hasUI) {
              const icon = subagentStatusIcon(next.status);
              ctx.ui.notify(`${icon} ${next.name}: ${clip(next.summary, 180)}`, "info");
            }
          }
        }
        if (previous && !previous.ended && existsSync(sessionFile + ".exitcode")) {
          try {
            const raw = readFileSync(sessionFile + ".exitcode", "utf-8").trim();
            if (raw) {
              const [codeStr, runId] = raw.split(/\s+/);
              if (!previous.runId || !runId || runId === previous.runId) {
                const code = parseInt(codeStr, 10);
                const status = code === 0 ? "completed" : code === 130 ? "closed" : "failed";
                const next: ChildRecord = {
                  ...previous,
                  status,
                  ended: true,
                  updatedAt: new Date().toISOString(),
                  summary: previous.summary || (code === 130 ? "Subagent cancelled by user" : `Subagent exited with code ${code}`),
                };
                persist(next);
                if (ctx?.hasUI) {
                  const icon = subagentStatusIcon(next.status);
                  ctx.ui.notify(`${icon} ${next.name}: ${clip(next.summary, 180)}`, "info");
                }
              }
            }
          } catch {}
        }
        // Coalesce actual events received during I/O, not timer-based polling.
      } while (currentGeneration === generation && dirty.has(sessionFile));
    })().finally(() => { if (pending.get(sessionFile) === work) pending.delete(sessionFile); });
    pending.set(sessionFile, work);
    return work;
  }
  function attach() {
    for (const record of records.values()) {
      if (!["running", "blocked"].includes(record.status)) continue;
      const dir = dirname(record.sessionFile);
      if (watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_event, filename) => {
          const file = filename?.toString();
          for (const record of records.values()) {
            if (dirname(record.sessionFile) === dir && (!file || file === basename(record.sessionFile) + PROGRESS_SUFFIX || file === basename(record.sessionFile) + ".exitcode")) {
              void ingest(record.sessionFile).catch(() => {});
            }
          }
        });
        watcher.unref?.();
        watcher.on("error", () => { watcher.close(); watchers.delete(dir); });
        watchers.set(dir, watcher);
      } catch { /* A fresh child's directory may not exist yet. Retry at the next lifecycle boundary. */ }
    }
    for (const [dir, watcher] of watchers) {
      if (![...records.values()].some(r => ["running", "blocked"].includes(r.status) && dirname(r.sessionFile) === dir)) {
        watcher.close(); watchers.delete(dir);
      }
    }
  }
  function close() {
    generation++;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear(); pending.clear(); dirty.clear();
  }
  /**
   * Branch entries that describe children THIS session knows about.
   *
   * A seeded child inherits its parent's checkpoint entries verbatim. Replaying
   * them would show the child its parent's other delegates — siblings it must not
   * act on, resume, or report as its own — and would spend context on every
   * request via the snapshot below. Filtering to this session's own entries keeps
   * legitimate nesting (a child that spawns its own workers) working while making
   * the parent's registry invisible.
   */
  function registryEntries(context: ExtensionContext): any[] {
    const branch = context.sessionManager.getBranch();
    const header = (context.sessionManager as any).getHeader?.();
    // Gate on `seeded` alone: the seed marker on the branch is authoritative.
    // Child identity is still proven from this session's own file, so an
    // inherited env cannot make a normal session drop its own registry.
    const isChild = isSubagentChildSession(context);
    return childContextState(branch, header, isChild).seeded ? ownEntries(branch) : branch;
  }
  function restore(context: ExtensionContext) {
    close(); ctx = context;
    records = recordsFromBranch(registryEntries(context));
    // A tree move may hide launches. Never leak their status into another branch.
    for (const file of observed) if (!records.has(file)) observed.delete(file);
    attach(); widget();
  }
  async function refresh(context: ExtensionContext) {
    ctx = context;
    // Include finalized result/ping messages even if no message lifecycle event was emitted.
    records = recordsFromBranch(registryEntries(context));
    attach();
    await Promise.all([...records.values()].filter(r => ["running", "blocked"].includes(r.status)).map(r => ingest(r.sessionFile)));
    widget();
  }

  pi.on("session_start", (_event, context) => { observed.clear(); restore(context); });
  pi.on("session_tree", (_event, context) => restore(context));
  pi.on("model_select", (_event, context) => refresh(context));
  pi.on("session_shutdown", () => { close(); observed.clear(); ctx?.ui.setWidget("subagent-checkpoints", undefined); ctx = undefined; });

  pi.events?.on("subagent-checkpoints:open-dialog", () => {
    if (ctx && ctx.hasUI) {
      void browseSubagents(ctx);
    }
  });

  const isLaunchTool = (name: string) => {
    const verb = delegationTool(name)?.verb;
    return verb === "spawn" || verb === "resume";
  };

  pi.on("tool_execution_start", event => {
    if (isLaunchTool(event.toolName)) launchInputs.set(event.toolCallId, event.args);
  });
  pi.on("tool_execution_end", async (event, context) => {
    ctx = context;
    if (!event.isError && isLaunchTool(event.toolName)) {
      const d = event.result?.details;
      const file = d?.sessionFile ?? d?.sessionPath;
      const record = launched(d, launchInputs.get(event.toolCallId), records.get(file));
      if (record) { observed.add(record.sessionFile); persist(record); attach(); await ingest(record.sessionFile); }
    }
    launchInputs.delete(event.toolCallId);
    // Todos are semantic milestones; arbitrary reads/bash calls are deliberately not streamed.
    if (childSession && childRun && isTodoTool(event.toolName) && !event.isError) {
      const d = event.result?.details;
      const items = d?.tasks ?? d?.items ?? d?.state?.items;
      if (Array.isArray(items) && items.length) {
        const settled = new Set(items.filter((item: any) => item.status === "done").map((item: any) => item.id));
        const summary = items.map((item: any) => `${item.status}: ${clip(item.title ?? item.text, 180)}${item.note ? ` (${clip(item.note, 200)})` : ""}`).join("\n");
        // `blocked` is derived now: a task is blocked when a dependency is not done.
        const blocked = items.some((item: any) => item.status === "open" && Array.isArray(item.deps) && item.deps.some((dep: string) => !settled.has(dep)));
        await publish({ summary, blocked, next: items.find((item: any) => item.status === "claimed")?.title ?? "" });
      }
    }
  });
  pi.on("message_end", async (event, context) => {
    ctx = context;
    const message = event.message;
    if (message.role === "custom") {
      const record = outcome(message, records.get((message.details as any)?.sessionFile));
      if (record) {
        if (record.ended && record.sessionFile) {
          try {
            const vccBrief = await compileSubagentSession(record.sessionFile);
            if (vccBrief) {
              record.summary = clip(vccBrief, 3000);
            }
          } catch {}
        }
        persist(record); attach();
      }
    }
  });

  // Request-local injection survives BOTH native compaction and the custom turn_end compactor.
  // It does not overwrite either summarizer or keep appending copies to the transcript.
  pi.on("context", async (event, context) => {
    // A spec-only reviewer sees only its pinned ticket. Checkpoint snapshots and
    // parent briefs are author-context channels; never inject them, even if a
    // restored session somehow carries records.
    if (specOnlyReviewer) return { messages: event.messages };
    await refresh(context);
    const snapshot = checkpointContext(records, observed);
    const messages = event.messages.filter(m =>
      !(m.role === "custom" && (m.customType === CONTEXT_TYPE || m.customType === PARENT_BRIEF_TYPE)));
    if (snapshot) messages.push({ role: "custom", customType: CONTEXT_TYPE, content: snapshot, display: false, timestamp: Date.now() });
    const brief = await ensureParentBrief();
    if (brief) {
      messages.push({ role: "custom", customType: PARENT_BRIEF_TYPE, content: brief, display: false, timestamp: Date.now() });
    }
    return { messages };
  });
  pi.on("before_agent_start", () => childSession && childRun ? {
    message: {
      customType: "subagent-progress-guidance", display: false,
      content: [
        "Report meaningful milestones using agent_progress when available: findings, changed files, verification, next steps, and blockers. Do not report each tool call. Workflow todo changes also publish checkpoints automatically. Progress is not completion; keep Herdr's existing agent_done/agent_ping protocol.",
        specOnlyReviewer
          ? "You are an independent reviewer with no parent history. Judge only the pinned document in your ticket and the permitted paths. Missing context is a finding, not a reason to reconstruct the author's intent."
          : "",
        parentContext
          ? `Your parent session is ${parentContext.sessionFile} (your context: ${parentContext.provenance?.mode ?? "unknown"}). When you need context you do not have — a decision your parent made, a file it touched, or parent work newer than your snapshot — use agent_parent_recall (search) or agent_parent_digest (structured brief) instead of guessing or re-reading the repository. Both are read-only and never modify the parent session.`
          : "",
      ].filter(Boolean).join(" "),
    },
  } : undefined);

  // ── Child-side parent pull ────────────────────────────────────────────────
  // Registered only when a parent is actually reachable, so ordinary sessions
  // gain no dead tools. Both tools are read-only over the parent session file.
  if (parentContext) {
    pi.registerTool({
      name: "agent_parent_recall", label: "Recall From Parent",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Search your PARENT's session for context you were not seeded with: decisions it made, files it touched, or work it did after your snapshot. " +
        "Use instead of guessing or re-reading the repository. Read-only; never modifies the parent session.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search terms or regex over the parent transcript (e.g. 'retry|backoff'). Omit to list the most recent parent entries." })),
        expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices to return untruncated" })),
        page: Type.Optional(Type.Number({ description: "Page number (1-based) for paged search results" })),
        scope: Type.Optional(Type.Union([Type.Literal("lineage"), Type.Literal("all")], { description: "Parent branch scope. Default lineage (active branch only); all includes abandoned branches." })),
        newerThanSeed: Type.Optional(Type.Boolean({ description: "Only entries the parent added after your context snapshot. Defaults to true for fork children, false otherwise." })),
      }),
      async execute(_id, input) {
        const newerThanSeed = input.newerThanSeed ?? defaultNewerThanSeed(parentContext);
        const result = await recallSubagentHistory({
          sessionFile: parentContext.sessionFile,
          query: input.query,
          expand: input.expand,
          page: input.page,
          scope: input.scope,
          excludeEntryIds: newerThanSeed ? parentContext.seededEntryIds : undefined,
        });
        const bounded = boundPull(`${parentPullHeader(parentContext, newerThanSeed)}\n\n${result.output}`);
        return {
          content: [{ type: "text", text: bounded.text }],
          details: { parent: parentContext.sessionFile, count: result.count, totalPages: result.totalPages, newerThanSeed, truncated: bounded.truncated },
        };
      },
    });

    pi.registerTool({
      name: "agent_parent_digest", label: "Parent Digest",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description:
        "Get a compact structured brief of your PARENT's session (goal, files and changes, commits, key signals) compiled without any model call. " +
        "Cheaper than agent_parent_recall when you need the shape of the parent's work rather than a specific detail. Read-only.",
      parameters: Type.Object({}),
      async execute() {
        const brief = await compileSubagentSession(parentContext.sessionFile);
        if (!brief) {
          throw new Error("Could not compile a parent brief (pi-vcc unavailable or the parent session is unreadable). Use agent_parent_recall instead, or proceed with your own context.");
        }
        const bounded = boundPull(`${parentPullHeader(parentContext, false)}\n\n${clip(brief, PARENT_BRIEF_MAX_CHARS)}`);
        return {
          content: [{ type: "text", text: bounded.text }],
          details: { parent: parentContext.sessionFile, mode: "digest", truncated: bounded.truncated },
        };
      },
    });
  }

  function publish(input: { summary: string; files?: string[]; verification?: string; next?: string; blocked?: boolean }) {
    const run = childQueue.catch(() => {}).then(async () => {
      if (!childSession || !childRun) throw new Error("Milestones require a Herdr child session and run ID.");
      const previous = await readMilestone(childSession);
      const base = previous?.runId === childRun ? previous : undefined;
      const data = {
        summary: clip(input.summary), files: input.files ?? base?.files ?? [],
        verification: input.verification ?? base?.verification ?? "", next: input.next ?? "", blocked: input.blocked ?? false,
      };
      const revision = JSON.stringify(data);
      if (revision === childRevision) return;
      const milestone = milestoneOf({ ...data, version: 1, sessionFile: childSession, runId: childRun, updatedAt: new Date().toISOString() })!;
      await writeMilestone(milestone);
      childRevision = revision;
    });
    childQueue = run;
    return run;
  }

  if (childSession && childRun) pi.registerTool({
    name: "agent_progress", label: "Report Milestone", executionMode: "sequential",
    description: "Publish one meaningful milestone to the parent dashboard without ending the child or waking the parent model. Progress is not completion; use agent_ping for questions requiring an answer.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 1200 }),
      files: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })),
      verification: Type.Optional(Type.String({ maxLength: 800 })), next: Type.Optional(Type.String({ maxLength: 800 })), blocked: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, input) {
      await publish(input);
      return { content: [{ type: "text", text: "Milestone saved for the parent. This does not mark the task complete." }], details: { saved: true } };
    },
  });

  pi.registerTool({
    name: "agent_history", label: "Delegated Work History", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: "Review durable delegated-work checkpoints, run VCC-compiled digests, or perform targeted VCC searches over a child's session. Avoids full transcript dumps and saves tokens.",
    parameters: Type.Object({
      sessionPath: Type.Optional(Type.String({ description: "Target child session path" })),
      query: Type.Optional(Type.String({ description: "Search query across child conversation using VCC" })),
      expand: Type.Optional(Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" })),
      page: Type.Optional(Type.Number({ description: "Page number (1-based) for search results" })),
      vccSummary: Type.Optional(Type.Boolean({ description: "Generate a compact VCC summary (goals, files, signals, tool rollup) of the child session" })),
      transcript: Type.Optional(Type.Boolean({ description: "Fallback raw transcript preview (last 40 entries, capped)" })),
    }),
    async execute(_id, input, _signal, _update, context) {
      await refresh(context);
      const record = input.sessionPath ? records.get(input.sessionPath) : undefined;
      if (input.sessionPath && !record) throw new Error("Child session is not recorded on this active branch.");
      if ((input.transcript || input.query || input.expand || input.vccSummary) && !record) {
        throw new Error("Select a known child sessionPath to inspect its history.");
      }

      if (record) {
        if (input.vccSummary) {
          const vccBrief = await compileSubagentSession(record.sessionFile);
          if (vccBrief) {
            return {
              content: [{ type: "text", text: `VCC Algorithmic Brief for [${record.name}]:\n\n${vccBrief}` }],
              details: { sessionPath: record.sessionFile, mode: "vccSummary" },
            };
          }
        }

        if (input.query || input.expand) {
          const recallRes = await recallSubagentHistory({
            sessionFile: record.sessionFile,
            query: input.query,
            expand: input.expand,
            page: input.page,
          });
          return {
            content: [{ type: "text", text: recallRes.output }],
            details: { sessionPath: record.sessionFile, count: recallRes.count, totalPages: recallRes.totalPages },
          };
        }

        if (input.transcript) {
          return {
            content: [{ type: "text", text: transcriptPreview(record.sessionFile) }],
            details: { sessionPath: record.sessionFile, mode: "transcript" },
          };
        }

        return {
          content: [{ type: "text", text: describe(record, observed.has(record.sessionFile)) }],
          details: { sessionPath: record.sessionFile, mode: "checkpoint" },
        };
      }

      const text = checkpointContext(records, observed, 24000) || "No delegated work recorded on this branch.";
      return { content: [{ type: "text", text }], details: { count: records.size } };
    },
  });

  async function selectPopup(
    context: ExtensionContext,
    title: string,
    options: string[],
    hint = "Esc close",
  ): Promise<string | undefined> {
    if (typeof context.ui.custom !== "function") {
      return context.ui.select(title, options);
    }
    const titleLines = title.split("\n");
    const panelTitle = titleLines[0];
    const headerLines = titleLines.slice(1);
    return context.ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const list = new PopupList<string>({
        theme,
        title: panelTitle,
        hint,
        items: options,
        terminalRows: () => tui?.terminal?.rows ?? 24,
        header: headerLines.length ? [...headerLines.map(line => theme.fg("dim", line)), ""] : [],
        renderItem: (option, { selected }) =>
          `${selected ? theme.fg("accent", "→ ") : "  "}${option}`,
        onSelect: (option) => done(option),
        onCancel: () => done(undefined),
      });
      return list;
    }, { overlay: true, overlayOptions: popupOverlayOptions("85%", 46, "85%") as any });
  }

  async function textDetailPopup(
    context: ExtensionContext,
    title: string,
    text: string,
    hint = "Esc close",
  ): Promise<void> {
    if (typeof context.ui.custom !== "function") {
      await context.ui.editor(title, text);
      return;
    }
    const lines = text.split("\n");
    const viewport = 18;
    await context.ui.custom<void>((tui, theme, _keys, done) => {
      let scrollTop = 0;
      const maxScroll = () => Math.max(0, lines.length - viewport);
      const clamp = () => {
        scrollTop = Math.max(0, Math.min(scrollTop, maxScroll()));
      };
      const getVisible = (): PopupRow[] => {
        clamp();
        return lines.slice(scrollTop, scrollTop + viewport);
      };
      const panel = new PopupPanel({
        theme,
        title,
        hint,
        onKey(data) {
          if (isPopupCloseKey(data) || data === "escape" || data === "\x1b" || matchesKey(data, "enter") || data === "enter" || data === "\r") {
            done();
          } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
            scrollTop--;
            panel.setContent(getVisible());
            tui?.requestRender?.();
          } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
            scrollTop++;
            panel.setContent(getVisible());
            tui?.requestRender?.();
          } else if (matchesKey(data, "pageUp")) {
            scrollTop -= Math.max(1, viewport - 2);
            panel.setContent(getVisible());
            tui?.requestRender?.();
          } else if (matchesKey(data, "pageDown")) {
            scrollTop += Math.max(1, viewport - 2);
            panel.setContent(getVisible());
            tui?.requestRender?.();
          } else if (matchesKey(data, "home") || data === "g") {
            scrollTop = 0;
            panel.setContent(getVisible());
            tui?.requestRender?.();
          } else if (matchesKey(data, "end") || data === "G") {
            scrollTop = maxScroll();
            panel.setContent(getVisible());
            tui?.requestRender?.();
          }
        },
        onMouse(event) {
          if (event.type === "wheel" && event.wheelDelta) {
            scrollTop -= Math.sign(event.wheelDelta) * 3;
            panel.setContent(getVisible());
            return { handled: true, render: true };
          }
          return undefined;
        },
      });
      panel.setContent(getVisible());
      return panel;
    }, { overlay: true, overlayOptions: popupOverlayOptions("85%", 46, popupHeight(viewport)) as any });
  }

  async function browseSubagents(context: ExtensionContext) {
    await refresh(context);
    if (!context.hasUI) return;
    const rows = ordered(records);
    if (!rows.length) { context.ui.notify("No delegated work recorded on this branch.", "info"); return; }
    const options = rows.map((r, i) => {
      const unverified = stateLabel(r, observed.has(r.sessionFile)).startsWith("unverified");
      const icon = subagentStatusIcon(r.status, unverified);
      const state = unverified ? "unverified" : r.status;
      const mode = r.context ? ` — ${contextModeLabel(r.context)}` : "";
      return `${i + 1}. ${icon} ${r.name} — ${state}${mode} — ${clip(r.summary || r.task, 85).replace(/\s+/g, " ")}`;
    });
    const selected = await selectPopup(context, "Subagents — running and saved history", options);
    const index = options.indexOf(selected ?? "");
    if (index < 0) return;
    const record = rows[index];
    const unverified = stateLabel(record, observed.has(record.sessionFile)).startsWith("unverified");
    const icon = subagentStatusIcon(record.status, unverified);
    const actions = ["View saved checkpoint / result", "View VCC-compiled summary", "View saved transcript preview", "Show reopen command"];
    if (record.ended) actions.push("Request resume in a new Herdr pane");
    const provenanceSummary = record.context
      ? `\nContext: ${contextModeLabel(record.context)}\nParent: ${record.context.parentSession}`
      : "";
    const action = await selectPopup(context, `${icon} ${record.name} — ${stateLabel(record, observed.has(record.sessionFile))}${provenanceSummary}\n${clip(record.summary || record.task, 260)}\n${record.sessionFile}`, actions);
    if (action === actions[0]) await textDetailPopup(context, "Saved checkpoint — view/copy; edits are discarded", describe(record, observed.has(record.sessionFile)));
    else if (action === actions[1]) {
      try {
        const vccBrief = (await compileSubagentSession(record.sessionFile)) || "VCC summary could not be compiled for this session.";
        await textDetailPopup(context, `VCC Algorithmic Summary — ${record.name}`, vccBrief);
      } catch (error) {
        context.ui.notify(`Cannot compile VCC summary: ${String(error)}`, "error");
      }
    } else if (action === actions[2]) {
      try { await textDetailPopup(context, "Saved transcript preview — view/copy; edits are discarded", transcriptPreview(record.sessionFile)); }
      catch (error) { context.ui.notify(`Cannot read saved child: ${String(error)}`, "error"); }
    } else if (action === actions[3]) {
      await textDetailPopup(context, "Reopen an ENDED child only; never concurrently write its session", `pi --session '${record.sessionFile.replace(/'/g, "'\\''")}'\n\n${record.status === "running" ? "Last known running: inspect its existing Herdr pane first. Automatic completion monitoring was not reattached after reload." : "Only use after the original child has ended."}`);
    } else if (action === "Request resume in a new Herdr pane") {
      const message = await context.ui.input("Follow-up / answer for the child (cancel leaves it unchanged)");
      if (!message?.trim()) return;
      await refresh(context);
      const current = records.get(record.sessionFile);
      if (!current?.ended || current.runId !== record.runId) {
        context.ui.notify("This child changed while the dialog was open. Inspect its current pane/history before resuming.", "warning");
        return;
      }
      pi.sendUserMessage(`Resume this ended Herdr child using agent_resume with these exact arguments: ${JSON.stringify({ sessionPath: record.sessionFile, name: record.name, message })}. Do not start a second writer if the original child is still running; verify that prerequisite first.`);
    }
  }

  /**
   * `/subagents gc` — offer to collect old fork transcript copies.
   *
   * Always explicit, never automatic: a transcript is evidence. Nothing is
   * removed until the user confirms the exact list, and milestone sidecars are
   * always kept.
   */
  async function collectSubagents(context: ExtensionContext, args: string) {
    await refresh(context);
    const olderThanDays = Number.parseInt(args.match(/--older-than=(\d+)/)?.[1] ?? "", 10);
    const candidates = retentionCandidates(
      records.values(),
      observed,
      Number.isFinite(olderThanDays) ? { olderThanDays } : {},
    );
    if (!context.hasUI) {
      context.ui?.notify?.(describeRetention(candidates), candidates.length ? "warning" : "info");
      return;
    }
    const report = describeRetention(candidates);
    if (!candidates.length) { context.ui.notify(report, "info"); return; }
    const confirmed = await context.ui.confirm(
      "Collect fork transcripts?",
      report,
    );
    if (!confirmed) { context.ui.notify("Nothing deleted.", "info"); return; }
    const removed: string[] = [];
    for (const candidate of candidates) {
      try {
        await rm(candidate.sessionFile, { force: true });
        removed.push(candidate.record.name);
      } catch { /* keep going: one failure must not abort the rest */ }
    }
    context.ui.notify(
      `Collected ${removed.length}/${candidates.length} fork transcripts` +
      (removed.length ? `: ${removed.join(", ")}` : "") +
      ". Milestone sidecars kept.",
      "info",
    );
  }

  async function handleDelegationSwitch(
    args: string,
    piInstance: ExtensionAPI,
    context: ExtensionContext,
  ): Promise<void> {
    const parsed = parseSubagentsCommand(args);
    // The switch decision lives on the branch, not in a module variable: it must
    // survive reload/tree moves and, critically, still bind mode restores so a
    // Plan/Supervise exit cannot resurrect a tool the user switched off.
    const branchDisabled = () => switchStateFromBranch(registryEntries(context)).disabled;
    switch (parsed.action) {
      case "status": {
        context.ui.notify(formatDelegationStatus(getDelegationStatus(piInstance)), "info");
        break;
      }
      case "help": {
        const helpText =
          "Delegation switch commands:\n" +
          "  /subagents status  - show the agent_* surface and what is switched off\n" +
          "  /subagents on      - turn the delegation tools ON for this session\n" +
          "  /subagents off     - turn the delegation tools OFF for this session\n" +
          "  /subagents save    - persist the current preference to settings.json\n" +
          "  /subagents gc      - offer old fork copies for collection\n" +
          "\nThere is one namespace (agent_*) and one switch. The v1 subagent surface\n" +
          "no longer exists. The switch never touches unrelated tools: bash, MCP\n" +
          "servers and other extensions keep their loadout. It is a session decision\n" +
          "and it survives entering and leaving Plan/Supervise mode.";
        context.ui.notify(helpText, "info");
        break;
      }
      case "save": {
        const status = getDelegationStatus(piInstance);
        const result = saveDelegationDefault(status.enabled);
        context.ui.notify(result.message, result.success ? "info" : "error");
        break;
      }
      case "on":
      case "off": {
        const result = applyDelegationToggle(piInstance, parsed.action === "on", branchDisabled());
        // Persist the decision so a mode exit, reload, or tree move derives the
        // same loadout instead of undoing the switch.
        piInstance.appendEntry(DELEGATE_SWITCH_TYPE, { disabled: result.disabled });
        context.ui.notify(result.message, "info");
        break;
      }
      default:
        return browseSubagents(context);
    }
  }

  pi.registerCommand("subagents", {
    description: "Browse delegated work, milestones, results and saved transcripts; `/subagents on|off|status` to switch the delegation surface; `/subagents gc` for collection.",
    handler: async (args, context) => {
      const trimmed = (args ?? "").trim();
      if (/^gc(?:\s|$)/.test(trimmed)) {
        return collectSubagents(context, trimmed);
      }
      if (isSwitchCommand(trimmed)) {
        return handleDelegationSwitch(trimmed, pi, context);
      }
      return browseSubagents(context);
    },
  });
}
