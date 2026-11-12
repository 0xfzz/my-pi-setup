// Base shell: the three minimal pi regions (header, transcript, composer)
// with plugin slots around them, keyboard shortcuts, client-side routing
// to plugin pages (/plugins/:id), and region overrides — a plugin that
// declares { kind: "override", region } replaces the base region while its
// view is published, and the built-in region returns when it is not.

import { useEffect, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { usePiSession } from "./use-session.ts";
import { Transcript } from "./transcript.tsx";
import { Composer } from "./composer.tsx";
import { SessionSidebar } from "./sidebar.tsx";
import { NewSessionDialog } from "./new-session-dialog.tsx";
import { CustomPopups, EditorWidgets, ReloadingBanner, StatusChips, ToastStack, UiPromptBanner } from "./popups.tsx";
import { DialogLayer, InfoDialog, LoginDialog, LogoutDialog, ModelPickerDialog, ScopedModelsDialog, SettingsDialog, ThinkingPickerDialog, TreeSelectorDialog, TrustDialog } from "./dialogs.tsx";
import type { WebTreeNode } from "../shared/tree.ts";
import { SlotHost } from "./plugins/slots.tsx";
import { PluginSidePanel } from "./plugins/PluginSidePanel.tsx";
import { PanelLauncher } from "./plugins/panel-launcher.tsx";
import { buildPanelEntries, FILES_PANEL_ID } from "./plugins/panel-entry.ts";
import { availablePanelPlugins, isPanelPlugin } from "./plugins/panel-policy.ts";
import { pinPanel, seedPins, unpinPanel } from "./plugins/pin-policy.ts";
import { browserStorage, loadPinnedIds, savePinnedIds } from "./plugins/pin-storage.ts";
import { FilesPanel } from "./plugins/files/FilesPanel.tsx";
import { Group, Panel, Separator } from "react-resizable-panels";
import { PluginActionShortcuts } from "./plugins/PluginActionShortcuts.tsx";
import { PluginPage, parsePluginRoute } from "./plugins/PluginLayout.tsx";
import { PluginViewRenderer } from "./plugins/PluginViewRenderer.tsx";
import { resolveRegionOverrides, type RegionOverride } from "../shared/regions.ts";

function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return path;
}

/** A base region replaced by a plugin's declarative view. */
function RegionOverrideView({
  override,
  region,
}: {
  override: RegionOverride;
  region: string;
}) {
  return (
    <div className={`app-region-override app-region-override-${region}`} data-region-override={region}>
      <PluginViewRenderer view={override.view} />
    </div>
  );
}

export function AppShell() {
  const session = usePiSession();
  const route = useRoute();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // Narrow screens: the sidebar starts collapsed and opens as an overlay.
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720);
  // Wide screens use resizable panels; narrow fall back to overlay/drawers.
  const [wide, setWide] = useState(() => window.innerWidth > 720);
  // Right-hand plugin panel (Artifacts, Delegated work / monitor, etc.)
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [activeSidePlugin, setActiveSidePlugin] = useState<string | null>(null);
  // The launcher's pinned-panel list; null means "not seeded yet" (§5.2).
  const [pinnedIds, setPinnedIds] = useState<string[] | null>(() => loadPinnedIds(browserStorage()));
  const [pinError, setPinError] = useState<string | null>(null);

  const handleOpenSidePanel = (pluginId: string) => {
    setActiveSidePlugin(pluginId);
    setSidePanelOpen(true);
  };

  // The web-ported TUI dialogs. One open dialog at a time — like the TUI.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [treeNodes, setTreeNodes] = useState<WebTreeNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const [trustOpen, setTrustOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [infoDialog, setInfoDialog] = useState<{ title: string; markdown?: string; lines?: string[] } | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  /** Client-dismissed extension dialogs: dialogId → the dismissed view
   * object. A NEW publish (different object) shows it again. */
  const [dismissedDialogs, setDismissedDialogs] = useState<Map<string, unknown>>(new Map());

  // A session-side bare /model or /thinking (dispatched through the
  // composer) asked the web to open its dialog.
  const dialogRequest = session.dialogRequest;
  useEffect(() => {
    if (dialogRequest === null) return;
    if (dialogRequest.dialog === "models") setModelPickerOpen(true);
    else if (dialogRequest.dialog === "thinking") setThinkingPickerOpen(true);
    session.clearDialogRequest();
  }, [dialogRequest, session]);

  // Opening the model picker (or /scoped-models) refreshes the list
  // (sessions that attach without posting web_models still get one).
  useEffect(() => {
    if ((modelPickerOpen || scopedModelsOpen) && session.selectedId !== null) {
      void session.fetchModels(session.selectedId);
    }
  }, [modelPickerOpen, scopedModelsOpen, session.selectedId, session.fetchModels]);

  // Crossing from wide to narrow closes the sidebar instead of leaving an
  // overlay + scrim stranded over the shrunken layout.
  useEffect(() => {
    let wasWide = window.innerWidth > 720;
    const onResize = (): void => {
      const wideNow = window.innerWidth > 720;
      setWide(wideNow);
      if (wasWide && !wideNow) {
        setSidebarOpen(false);
        setSidePanelOpen(false);
      }
      wasWide = wideNow;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Plugin pages: /plugins/:id renders the descriptor's page surface with
  // its live view for the selected session and its actions.
  const pluginId = parsePluginRoute(route);
  if (pluginId !== null) {
    const plugin = session.plugins.find((p) => p.id === pluginId);
    if (plugin !== undefined) {
      return (
        <PluginPage
          plugin={plugin}
          view={session.pluginViews[plugin.id] ?? null}
          sessionId={session.selectedId}
          plugins={session.plugins}
        />
      );
    }
  }

  const headerStatus = session.connection === "connected"
    ? (session.sessionState?.model
      ? `${session.sessionState.model.provider}/${session.sessionState.model.id}`
      : "connected")
    : session.connection;
  const selected = session.sessions.find((summary) => summary.id === session.selectedId);
  const headerCwd = selected ? selected.cwd : "";
  const headerLabel = selected?.name ?? (headerCwd.split("/").filter(Boolean).at(-1) || "Workspace");

  // The web side of the ported TUI commands: /model, /thinking, /session,
  // /changelog, /copy, /export, /resume. Each maps to a web dialog or
  // action; dispatchable session commands (/compact, /name, …) still go
  // through the prompt path.
  const handleWebCommand = (name: string, args: string): void => {
    if (name === "model") {
      if (args.trim() !== "" && session.selectedId !== null) {
        // /model <provider/id>: apply directly, like the TUI's exact match.
        void applyModelByRef(args.trim());
      } else {
        setModelPickerOpen(true);
      }
      return;
    }
    if (name === "thinking") {
      if (args.trim() !== "" && session.selectedId !== null) {
        void session.setThinking(args.trim().toLowerCase()).then((error) => {
          if (error !== null) setModelError(error);
        });
      } else {
        setThinkingPickerOpen(true);
      }
      return;
    }
    if (name === "session") {
      openSessionInfo();
      return;
    }
    if (name === "hotkeys") {
      setInfoDialog({ title: "Web Keybindings", lines: WEB_HOTKEYS });
      return;
    }
    if (name === "changelog") {
      void openChangelog();
      return;
    }
    if (name === "copy") {
      void copyLastAssistant();
      return;
    }
    if (name === "export") {
      exportTranscript();
      return;
    }
    if (name === "resume") {
      setSidebarOpen(true);
      return;
    }
    if (name === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (name === "scoped-models") {
      setScopedModelsOpen(true);
      return;
    }
    if (name === "trust") {
      setTrustOpen(true);
      return;
    }
    if (name === "login") {
      setLoginOpen(true);
      return;
    }
    if (name === "logout") {
      setLogoutOpen(true);
      return;
    }
  };

  const openTreePicker = (): void => {
    const id = session.selectedId;
    if (id === null) return;
    setTreeError(null);
    setTreeNodes(null);
    // The dispatch reached the pi process; its tree projection follows
    // within a bridge round trip — poll briefly for it.
    let attempts = 0;
    const poll = (): void => {
      attempts += 1;
      void fetch(`/api/agent/${encodeURIComponent(id)}/tree`)
        .then(async (res) => {
          if (res.status === 404 && attempts < 12) {
            setTimeout(poll, 250);
            return;
          }
          if (!res.ok) {
            setTreeError(`tree unavailable (HTTP ${res.status})`);
            return;
          }
          const body = (await res.json()) as { nodes?: WebTreeNode[] };
          if (body.nodes !== undefined && body.nodes.length > 0) setTreeNodes(body.nodes);
          else if (attempts < 12) setTimeout(poll, 250);
        })
        .catch(() => {
          if (attempts < 12) setTimeout(poll, 250);
          else setTreeError("tree could not be fetched");
        });
    };
    poll();
  };

  // /model <ref>: the TUI's exact-match semantics, applied through the
  // same POST the picker uses (so it works for bridge and in-process).
  const applyModelByRef = async (ref: string): Promise<void> => {
    const [provider, ...rest] = ref.split("/");
    if (rest.length === 0) {
      setModelError("usage: /model provider/model-id");
      return;
    }
    const id = rest.join("/");
    setModelBusy(true);
    setModelError(null);
    const error = await session.setModel(provider, id);
    setModelBusy(false);
    if (error !== null) setModelError(error);
  };

  const pickModel = async (provider: string, id: string): Promise<void> => {
    setModelBusy(true);
    setModelError(null);
    const error = await session.setModel(provider, id);
    setModelBusy(false);
    if (error === null) {
      setModelPickerOpen(false);
    } else {
      setModelError(error);
    }
  };

  const pickThinking = async (level: string): Promise<void> => {
    const error = await session.setThinking(level);
    if (error === null) {
      setThinkingPickerOpen(false);
      setModelError(null);
    } else {
      setModelError(error);
    }
  };

  // The web frontend's keymap — /hotkeys for the web, mirroring the TUI's
  // own reference for its keys. Web-side data, like /session and /copy.
  const WEB_HOTKEYS = [
    "Enter — send the prompt",
    "Shift+Enter — newline",
    "Escape — abort the running turn (like the TUI)",
    "Up / Down — browse palette and history",
    "Tab — complete palette selection",
    "/ — open the command palette",
    "@ — mention a file (pi's autocomplete)",
    "! — run a shell command (bash row)",
    "Ctrl+V — paste images",
    "Ctrl+K — copy last reply",
  ];

  // /session: the client's own data — session identity, model, context
  // usage, message count. Works for bridge and in-process sessions alike.
  const openSessionInfo = (): void => {
    const state = session.sessionState;
    const entries = session.history.length;
    const usage = state?.contextUsage;
    setInfoDialog({
      title: "Session Info",
      lines: [
        `ID: ${session.selectedId ?? "—"}`,
        selected !== undefined ? `Cwd: ${selected.cwd}` : "Cwd: —",
        state?.model !== undefined ? `Model: ${state.model.provider}/${state.model.id}` : "Model: —",
        state?.thinkingLevel !== undefined ? `Thinking: ${state.thinkingLevel}` : "Thinking: —",
        `Messages: ${entries}`,
        usage !== null && usage !== undefined
          ? `Context: ${Math.round(usage.percent)}% of ${(usage.contextWindow / 1000).toFixed(0)}k (${(usage.tokens / 1000).toFixed(1)}k tokens)`
          : "Context: —",
      ],
    });
  };

  // /changelog: the installed pi package's changelog, from the server.
  const openChangelog = async (): Promise<void> => {
    try {
      const response = await fetch("/api/changelog");
      if (!response.ok) {
        setInfoDialog({ title: "Changelog", lines: ["No changelog found."] });
        return;
      }
      const data = (await response.json()) as { markdown?: string };
      setInfoDialog({
        title: "What's New",
        ...(data.markdown !== undefined ? { markdown: data.markdown } : { lines: ["No changelog entries found."] }),
      });
    } catch {
      setInfoDialog({ title: "Changelog", lines: ["Changelog unavailable."] });
    }
  };

  // /copy: the last assistant message, straight into the browser clipboard.
  const copyLastAssistant = async (): Promise<void> => {
    let text = "";
    for (let i = session.history.length - 1; i >= 0 && text === ""; i--) {
      const entry = session.history[i];
      if (entry?.role === "assistant") {
        text = entry.blocks
          .filter((block) => block.kind === "text")
          .map((block) => (block.kind === "text" ? block.text : ""))
          .join("\n\n")
          .trim();
      }
    }
    if (text === "") {
      setModelError("No agent messages to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setModelError(null);
    } catch {
      setModelError("Clipboard write failed.");
    }
  };

  // /export: the transcript as a markdown download.
  const exportTranscript = (): void => {
    const parts: string[] = [];
    for (const entry of session.history) {
      if (entry.role === "user") {
        parts.push("## User\n");
        for (const block of entry.blocks) {
          if (block.kind === "text") parts.push(block.text);
        }
      } else {
        parts.push("## pi\n");
        for (const block of entry.blocks) {
          if (block.kind === "text") parts.push(block.text);
          else if (block.kind === "bash") parts.push("```\n$ " + block.command + "\n" + block.output + "\n```");
          else if (block.kind === "toolCall") parts.push("```\n[tool] " + block.toolName + " " + block.rawInput + "\n```");
        }
      }
      parts.push("");
    }
    const blob = new Blob([`# pi session — ${session.selectedId ?? ""}\n\n${parts.join("\n")}`], {
      type: "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pi-session-${session.selectedId ?? "export"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // The transcript's working line shows while a reply streams or the session
  // reports itself running (ui.session.lifecycle); a hidden working model
  // never forces the line on.
  const showWorking =
    session.streaming.isStreaming
    || (session.uiRunning && (session.working?.visible ?? true));

  // Region overrides: header, status (inside the header), transcript and
  // composer. Resolved from the same per-session views the slots render.
  const { regions, conflicts } = resolveRegionOverrides(session.plugins, session.pluginViews);
  const panelPlugins = availablePanelPlugins(session.plugins, session.pluginViews);
  const inlinePlugins = session.plugins.filter((plugin) => !isPanelPlugin(plugin));
  const panelEntries = buildPanelEntries(
    session.plugins,
    new Set(panelPlugins.map((plugin) => plugin.id)),
    session.selectedId !== null,
  );
  const availablePanelIdsInOrder = panelEntries.filter((entry) => entry.available).map((entry) => entry.id);
  const resolvedPins = seedPins(availablePanelIdsInOrder, pinnedIds);
  const handlePin = (id: string): void => {
    const result = pinPanel(resolvedPins, id);
    if (!result.ok) {
      setPinError(result.error);
      return;
    }
    setPinError(null);
    setPinnedIds(result.pinned);
    savePinnedIds(browserStorage(), result.pinned);
  };
  const handleUnpin = (id: string): void => {
    const next = unpinPanel(resolvedPins, id);
    setPinError(null);
    setPinnedIds(next);
    savePinnedIds(browserStorage(), next);
  };
  const openPanelPluginId = sidePanelOpen
    && (activeSidePlugin === FILES_PANEL_ID || panelPlugins.some((plugin) => plugin.id === activeSidePlugin))
    ? activeSidePlugin
    : null;

  const sidebarNode = (
    <SessionSidebar
      sessions={session.sessions}
      selectedId={session.selectedId}
      onSelect={(id) => {
        session.setSelectedId(id);
        if (window.innerWidth <= 720) setSidebarOpen(false);
      }}
      selectedRunning={session.streaming.isStreaming || session.uiRunning}
      onNewSession={() => setNewSessionOpen(true)}
    />
  );

  const mainColumn = (
    <div className="app-main">
      {regions.header !== undefined ? (
        <header className="app-header">
          <RegionOverrideView override={regions.header} region="header" />
        </header>
      ) : (
        <header className="app-header">
          <button
            type="button"
            className="app-sidebar-toggle"
            aria-label="Toggle session list"
            title={sidebarOpen ? "Hide sessions" : "Show sessions"}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((open) => !open)}
          >
            <SidebarSimple size={18} />
          </button>
          <div className="app-header-project" title={headerCwd || "Your local pi workspace"}>
            <span className="app-header-title">{headerLabel}</span>
            <span className="app-header-caption">{selected ? "Session" : "pi"}</span>
          </div>
          <StatusChips statuses={session.statuses} />
          <span className="app-header-status">
            {regions.status !== undefined ? (
              <RegionOverrideView override={regions.status} region="status" />
            ) : (
              headerStatus
            )}
          </span>
          <PanelLauncher
            entries={panelEntries}
            pinnedIds={resolvedPins}
            activePanelId={openPanelPluginId}
            onToggle={(id) => {
              if (openPanelPluginId === id) setSidePanelOpen(false);
              else handleOpenSidePanel(id);
            }}
            onPin={handlePin}
            onUnpin={handleUnpin}
            pinError={pinError}
          />
        </header>
      )}
      <UiPromptBanner prompt={session.uiPrompt} />
      <ReloadingBanner active={session.reloading} />
      {conflicts.length > 0 ? (
        <div className="app-region-conflicts" role="status">
          {conflicts.map((conflict) => (
            <span key={conflict.region} className="app-region-conflict">
              {conflict.region} override: {conflict.pluginIds.join(", ")} — last registered wins
            </span>
          ))}
        </div>
      ) : null}
      <SlotHost slot="top" plugins={inlinePlugins} views={session.pluginViews} />
      {/* Keep transcript controls positioned over the scroller. Plugin
          panels live beside the chat, not inside its reading area. */}
      <div className="app-transcript-frame">
        {regions.transcript !== undefined ? (
          <main className="app-transcript" aria-live="polite">
            <RegionOverrideView override={regions.transcript} region="transcript" />
          </main>
        ) : (
          <Transcript
            key={session.selectedId ?? "none"}
            history={session.history}
            userMessages={session.userMessages}
            streaming={session.streaming}
            toolStatus={session.toolStatus}
            toolResults={session.toolResults}
            working={session.working}
            showWorking={showWorking}
          />
        )}
      </div>
      <EditorWidgets widgets={session.widgets} placement="aboveEditor" />
      {regions.composer !== undefined ? (
        <div className="app-composer app-composer-override">
          <RegionOverrideView override={regions.composer} region="composer" />
        </div>
      ) : (
        <Composer
          disabled={session.selectedId === null || session.connection !== "connected"}
          busy={session.streaming.isStreaming || session.uiRunning}
          error={session.sendError}
          sessionCommands={session.sessionCommands}
          model={session.sessionState?.model}
          thinkingLevel={session.sessionState?.thinkingLevel}
          contextUsage={session.sessionState?.contextUsage ?? null}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          onOpenThinkingPicker={() => setThinkingPickerOpen(true)}
          onWebCommand={handleWebCommand}
          onWebCommandDispatch={(name, args) => {
            // The tree's pick carries the entry id; a bare /tree
            // dispatch asks the pi process for its tree and the
            // picker opens when the projection lands.
            if (name === "tree" && args.trim() === "") openTreePicker();
            void session.sendWebCommand(name, args);
          }}
          onSend={(text, images) => {
            void session.sendPrompt(text, images);
          }}
          sessionId={session.selectedId}
          onAbort={() => {
            void session.abort();
          }}
        />
      )}
      <EditorWidgets widgets={session.widgets} placement="belowEditor" />
      <SlotHost slot="bottom" plugins={inlinePlugins} views={session.pluginViews} />
    </div>
  );

  const rightPanel = openPanelPluginId === FILES_PANEL_ID ? (
    <FilesPanel
      open={sidePanelOpen}
      onClose={() => setSidePanelOpen(false)}
      sessionId={session.selectedId}
      rootLabel={selected?.cwd ?? ""}
      key={session.selectedId ?? "none"}
    />
  ) : (
    <PluginSidePanel
      open={openPanelPluginId !== null}
      activePluginId={openPanelPluginId}
      onClose={() => setSidePanelOpen(false)}
      plugins={panelPlugins}
      views={session.pluginViews}
      sessionId={session.selectedId}
    />
  );

  return (
    <div className="app-shell">
      <div className="app-body">
        {wide ? (
          <Group orientation="horizontal" className="app-shell-panels">
            {sidebarOpen ? (
              <>
                <Panel
                  id="sessions"
                  defaultSize="18"
                  minSize="11"
                  maxSize="44"
                  className="app-panel-slot"
                >
                  {sidebarNode}
                </Panel>
                <Separator className="app-resize-handle" />
              </>
            ) : null}
            <Panel id="main" minSize="30" className="app-panel-slot">
              {mainColumn}
            </Panel>
            {openPanelPluginId !== null ? (
              <>
                <Separator className="app-resize-handle" />
                <Panel
                  id="side"
                  defaultSize="27"
                  minSize="16"
                  maxSize="60"
                  className="app-panel-slot"
                >
                  {rightPanel}
                </Panel>
              </>
            ) : null}
          </Group>
        ) : (
          <>
            {sidebarOpen ? <div className="app-sidebar-scrim" onClick={() => setSidebarOpen(false)} /> : null}
            <div className={sidebarOpen ? "app-sidebar-wrap is-open" : "app-sidebar-wrap"}>
              {sidebarNode}
            </div>
            {mainColumn}
            {rightPanel}
          </>
        )}
      </div>
      <CustomPopups custom={session.custom} />
      <ToastStack notifications={session.notifications} />
      {/* The web-ported TUI dialogs. */}
      {modelPickerOpen ? (
        <ModelPickerDialog
          models={session.models.models}
          current={session.models.current ?? session.sessionState?.model}
          busy={modelBusy}
          error={modelError}
          onPick={(provider, id) => {
            void pickModel(provider, id);
          }}
          onClose={() => {
            setModelPickerOpen(false);
            setModelError(null);
          }}
        />
      ) : null}
      {thinkingPickerOpen ? (
        <ThinkingPickerDialog
          current={session.sessionState?.thinkingLevel}
          onPick={(level) => {
            void pickThinking(level);
          }}
          onClose={() => setThinkingPickerOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          sessionId={session.selectedId}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {scopedModelsOpen ? (
        <ScopedModelsDialog
          sessionId={session.selectedId}
          models={session.models.models}
          current={session.models.current ?? session.sessionState?.model}
          onClose={() => setScopedModelsOpen(false)}
        />
      ) : null}
      {trustOpen ? (
        <TrustDialog
          sessionId={session.selectedId}
          onClose={() => setTrustOpen(false)}
        />
      ) : null}
      {loginOpen ? (
        <LoginDialog
          sessionId={session.selectedId}
          onClose={() => setLoginOpen(false)}
        />
      ) : null}
      {logoutOpen ? (
        <LogoutDialog
          sessionId={session.selectedId}
          onClose={() => setLogoutOpen(false)}
        />
      ) : null}
      {treeNodes !== null ? (
        <TreeSelectorDialog
          nodes={treeNodes}
          onPick={(entryId) => {
            setTreeNodes(null);
            if (session.selectedId !== null) {
              void session.sendWebCommand("tree", entryId);
            }
          }}
          onClose={() => setTreeNodes(null)}
        />
      ) : null}
      {treeError !== null ? (
        <InfoDialog title="Session tree" lines={[treeError]} onClose={() => setTreeError(null)} />
      ) : null}
      {infoDialog !== null ? (
        <InfoDialog
          title={infoDialog.title}
          {...(infoDialog.markdown !== undefined ? { markdown: infoDialog.markdown } : {})}
          {...(infoDialog.lines !== undefined ? { lines: infoDialog.lines } : {})}
          onClose={() => setInfoDialog(null)}
        />
      ) : null}
      {/* Extension-published dialogs: the web UI extension surface. */}
      <DialogLayer
        pluginViews={session.pluginViews}
        sessionId={session.selectedId}
        dismissed={dismissedDialogs}
        onDismiss={(dialogId, view) => {
          setDismissedDialogs((prev) => new Map(prev).set(dialogId, view));
        }}
      />
      <PluginActionShortcuts plugins={session.plugins} sessionId={session.selectedId} />
      <NewSessionDialog
        open={newSessionOpen}
        sessions={session.sessions}
        onClose={() => setNewSessionOpen(false)}
        onStart={(cwd) => session.newSession(cwd)}
      />
    </div>
  );
}
