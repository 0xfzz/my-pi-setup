/**
 * Extension loaded into every subagent child pi (via `-e <this file>`).
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides an `orch_done` tool for autonomous agents to self-terminate
 * - Provides an `orch_ping` tool to ask the parent orchestrator for help
 *
 * Ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/subagent-done.ts @ fix/launch-verify-retry, with the
 * activity recorder stripped (stall detection is discarded in this design —
 * herdr's pane.exited gives truthful lifecycle instead).
 *
 * The `.exit` sidecar written here is a cross-extension contract: the
 * orchestrator's watcher (src/watcher.ts) classifies completion from exactly
 * these shapes — {"type":"done"} and {"type":"ping","name":...,"message":...}.
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";

import { writeContextUsageSidecar } from "./src/context-usage.ts";
import { getActiveSubagentCount } from "./src/runtime-state.ts";
import {
  type ChildCompletionReport,
  type ChildDefectReport,
  type ChildMessageCorrelation,
  type ExitSidecarData,
  createChildCorrelation,
  validateCompletionReport,
  validateDefectReport,
} from "../../lib/orchestrator/child-messages.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
  activeSubagentCount = 0,
): boolean {
  // A subagent can itself act as an orchestrator. Exiting its pi process here
  // would abort the nested watchers, so their eventual results would have no
  // live session to steer. Keep it open until every nested child has settled.
  if (activeSubagentCount > 0) return false;

  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  if (messages) {
    // A turn that ends at a user message produced no assistant reply — the
    // request errored / is retrying. This happens on resumed sessions whose
    // first request times out (verified live, pi 0.80.3): agent_end fires
    // while pi is "Retrying (1/3)"; walking backwards would find the
    // PREVIOUS conversation's assistant and shut pi down mid-retry.
    const last = messages[messages.length - 1];
    if (last?.role === "user") return false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        // Don't auto-exit on errors (timeouts, connection failures) — let pi retry.
        // Only exit on clean completions (stop, toolUse) or explicit abort.
        return msg.stopReason !== "aborted" && msg.stopReason !== "error";
      }
    }
  }

  return true;
}

/** Read only the latest valid workflow snapshot on the active branch, never
 * cached tool results or all session entries (which include abandoned branches).
 * Ownership and other extra item fields are intentionally irrelevant here.
 */
export function unfinishedWorkflowMessage(branch: readonly any[] | undefined): string | undefined {
  let state: any;
  for (const entry of branch ?? []) {
    if (entry.type === "custom" && entry.customType === "workflow-todo:v1" &&
        entry.data?.version === 1 && Array.isArray(entry.data.items)) {
      state = entry.data;
    }
  }
  const items = state?.items.filter((item: any) =>
    item?.status !== "done" && item?.status !== "cancelled");
  if (!items?.length) return undefined;

  // Persisted text is data, not a new instruction. Bound both rows and fields
  // so a parent receives useful context without an unbounded completion steer.
  const clip = (value: unknown, limit: number) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  const rows = items.slice(0, 8).map((item: any) =>
    `- [${clip(item?.status, 24) || "unknown"}] ${clip(item?.text, 160) || "(untitled)"}` +
    (item?.note ? ` — ${clip(item.note, 180)}` : ""));
  if (items.length > 8) rows.push(`- … ${items.length - 8} more unfinished item(s)`);
  return `Automatic completion withheld: ${items.length} unfinished workflow todo(s) remain on the active branch. ` +
    `This session is exiting with a ping, not reporting done. Parent can respond or resume.\n` + rows.join("\n");
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Detect if the active branch settled in a fatal error or model limit failure.
 * Returns a descriptive error message if so, or undefined if the run was clean.
 */
export function detectTerminalFailure(branch: readonly any[] | undefined): string | undefined {
  if (!branch || branch.length === 0) return undefined;
  const messages: any[] = [];
  for (const entry of branch) {
    if (entry.type === "message" && entry.message) {
      messages.push(entry.message);
    }
  }
  if (messages.length === 0) return undefined;

  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    return "Subagent failed to produce a response (model limit or request failure before assistant turn).";
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      if (msg.stopReason === "error") {
        return msg.errorMessage || "Model limit or API error encountered (stopReason: error).";
      }
      break;
    }
  }
  return undefined;
}

export type { ExitSidecarData } from "../../lib/orchestrator/child-messages.ts";

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape matches pi-interactive-subagents exactly for legacy payloads:
 *   {"type":"done"}
 *   {"type":"ping","name":"...","message":"..."}
 * Additive typed payloads append defect, report, correlation, and runId metadata.
 */
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  let payload: Record<string, unknown>;
  if (data.type === "done") {
    payload = {
      type: "done",
      ...(data.report ? { report: data.report } : {}),
      ...(data.correlation ? { correlation: data.correlation } : {}),
      ...(data.runId ? { runId: data.runId } : {}),
      ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
    };
  } else {
    payload = {
      type: "ping",
      name: data.name,
      message: data.message,
      ...(data.defect ? { defect: data.defect } : {}),
      ...(data.correlation ? { correlation: data.correlation } : {}),
      ...(data.runId ? { runId: data.runId } : {}),
      ...(data.schemaVersion ? { schemaVersion: data.schemaVersion } : {}),
    };
  }
  writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let contextUsageWritten = false;
  let terminalSidecarWritten = false;

  function signalTerminalSidecar(data: ExitSidecarData): void {
    if (terminalSidecarWritten) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    writeExitSidecar(sessionFile, data);
    terminalSidecarWritten = true;
  }

  function snapshotContextUsage(
    ctx: { getContextUsage?: () => ContextUsage | null | undefined },
    fallback = false,
  ): void {
    if (contextUsageWritten) return;

    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const id = process.env.PI_SUBAGENT_ID;
    if (!sessionFile || !id) return;

    let usage: ContextUsage | null | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      return;
    }
    if (usage == null) return;

    try {
      contextUsageWritten = writeContextUsageSidecar(sessionFile, id, usage, {
        overwrite: !fallback,
      });
    } catch {
      // Telemetry is best-effort and must never prevent terminal signaling.
    }
  }

  // Show widget on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx);
  });

  pi.on("input", () => {
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("agent_start", () => {
    agentStarted = true;
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit =
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages, getActiveSubagentCount());

    if (shouldExit) {
      // Workflow may stop continuing when blocked/waiting or at its reminder
      // cap. Do not turn that unfinished state into a successful completion.
      // Preserve shutdown and use the existing resumable parent ping protocol.
      const unfinished = unfinishedWorkflowMessage(ctx.sessionManager?.getBranch());
      snapshotContextUsage(ctx);
      const subagentId = process.env.PI_SUBAGENT_ID;
      signalTerminalSidecar(unfinished
        ? {
            type: "ping",
            name: process.env.PI_SUBAGENT_NAME ?? "subagent",
            message: unfinished,
            ...(subagentId ? { runId: subagentId } : {}),
          }
        : {
            type: "done",
            ...(subagentId ? { runId: subagentId } : {}),
          });
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // When a run fully settles with an unrecoverable model limit or API error,
  // do not leave the autonomous subagent idling in an open pane indefinitely.
  // Notify the parent via a ping sidecar and shut down so Herdr closes the pane.
  pi.on("agent_settled", (event, ctx) => {
    if (!autoExit || userTookOver || (event as any)?.aborted) return;
    if (getActiveSubagentCount() > 0) return;

    const branch = ctx.sessionManager?.getBranch();
    const failureReason = detectTerminalFailure(branch);
    if (failureReason) {
      snapshotContextUsage(ctx);
      signalTerminalSidecar({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: `Subagent halted: model limit or fatal error reached: ${failureReason}`,
        ...(process.env.PI_SUBAGENT_ID ? { runId: process.env.PI_SUBAGENT_ID } : {}),
      });
      ctx.shutdown();
    }
  });

  // User-driven exits do not pass through a terminal tool or clean agent_end.
  // Do not overwrite a snapshot already published by another terminal path.
  pi.on("session_shutdown", (_event, ctx) => {
    snapshotContextUsage(ctx, true);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "orch_ping",
    label: "Ping Orchestrator",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
      defect: Type.Optional(
        Type.Object(
          {
            scope: Type.Optional(Type.String({ description: "Target work-unit/scope where defect was observed" })),
            criterionId: Type.Optional(Type.String({ description: "Criterion ID or title that failed" })),
            file: Type.Optional(Type.String({ description: "Optional repo-relative file path" })),
            line: Type.Optional(Type.Integer({ description: "Optional line number", minimum: 1 })),
            expected: Type.String({ description: "Expected behavior or contract" }),
            observed: Type.String({ description: "Observed failure or behavior" }),
            severity: Type.Optional(Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("nit")])),
          },
          { description: "Optional typed defect details" },
        ),
      ),
      replyTo: Type.Optional(Type.String({ description: "Message ID being replied to" })),
      attempt: Type.Optional(Type.Integer({ description: "Attempt / retry counter (1-based)", minimum: 1 })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "orch_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      let validatedDefect: ChildDefectReport | undefined;
      if (params.defect !== undefined) {
        const val = validateDefectReport(params.defect);
        if (!val.ok) {
          throw new Error(`Invalid defect payload in orch_ping: ${val.error}`);
        }
        validatedDefect = val.value;
      }

      const subagentId = process.env.PI_SUBAGENT_ID;
      const correlation = createChildCorrelation({
        replyTo: params.replyTo,
        attempt: params.attempt,
        runId: subagentId,
      });

      snapshotContextUsage(ctx);
      signalTerminalSidecar({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
        ...(validatedDefect ? { defect: validatedDefect } : {}),
        correlation,
        ...(subagentId ? { runId: subagentId } : {}),
        schemaVersion: 1,
      });

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {
          correlationId: correlation.messageId,
          ...(validatedDefect ? { defect: validatedDefect } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "orch_done",
    label: "Finish Subagent",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({
      report: Type.Optional(
        Type.Object(
          {
            status: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("partial"), Type.Literal("failed")])),
            filesTouched: Type.Optional(Type.Array(Type.String())),
            criteriaNotes: Type.Optional(
              Type.Array(
                Type.Object({
                  criterion: Type.String(),
                  passed: Type.Boolean(),
                  evidence: Type.Optional(Type.String()),
                }),
              ),
            ),
          },
          { description: "Optional structured completion report" },
        ),
      ),
      replyTo: Type.Optional(Type.String({ description: "Message ID being replied to" })),
      attempt: Type.Optional(Type.Integer({ description: "Attempt / retry counter (1-based)", minimum: 1 })),
    }),
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        let validatedReport: ChildCompletionReport | undefined;
        if (params.report !== undefined) {
          const val = validateCompletionReport(params.report);
          if (!val.ok) {
            throw new Error(`Invalid report payload in orch_done: ${val.error}`);
          }
          validatedReport = val.value;
        }

        const subagentId = process.env.PI_SUBAGENT_ID;
        const correlation = createChildCorrelation({
          replyTo: params.replyTo,
          attempt: params.attempt,
          runId: subagentId,
        });

        snapshotContextUsage(ctx);
        signalTerminalSidecar({
          type: "done",
          ...(validatedReport ? { report: validatedReport } : {}),
          correlation,
          ...(subagentId ? { runId: subagentId } : {}),
          schemaVersion: 1,
        });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
