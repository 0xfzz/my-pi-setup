import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import { SECTION_EVENT, REFRESH_EVENT, type SectionOffer, type SidebarSection } from "../lib/sidebar-channel.ts";
import { SIDEBAR_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_COLUMNS, SidebarMount, fit, sidebarWidth, wrapTodoRow } from "../lib/sidebar-layout.ts";
import { isSubagentChildSession } from "../lib/subagent-context.ts";
import { SidebarResizer } from "../lib/sidebar-resize.ts";
import { registerWorkflowActions } from "../lib/workflow-actions.ts";
import { AnimationRegistry, SidebarAnimationPlayer, animationHeight, ANIMATION_REGISTER_EVENT, type AsciiAnimationPiece } from "../lib/sidebar-animation.ts";
import { feedAquarium } from "../lib/sidebar-aquarium.ts";

export default function sidebarExtension(pi: ExtensionAPI) {
  registerWorkflowActions(pi);
  let active = false;
  let enabled = true;
  let width = SIDEBAR_WIDTH;
  let resizer: SidebarResizer | undefined;
  let animEnabled = true;
  const animRegistry = new AnimationRegistry({ autoRestore: true });
  let animPlayer: SidebarAnimationPlayer | undefined;
  let context: ExtensionContext | undefined;
  let tui: TUI | undefined;
  let mount: SidebarMount | undefined;
  let queued = false;
  const sections = new Map<string, SidebarSection>();
  const refresh = () => { pi.events.emit(REFRESH_EVENT, undefined); tui?.requestRender(); };
  const sectionBounds = new Map<string, { start: number; end: number }>();
  let animBounds: { start: number; end: number; width: number } | undefined;

  pi.events.on(SECTION_EVENT, (data: unknown) => {
    if (!active) return;
    const offer = data as SectionOffer;
    sections.set(offer.section.id, offer.section);
    offer.handled = true;
    tui?.requestRender();
  });

  pi.events.on(ANIMATION_REGISTER_EVENT, (data: unknown) => {
    if (data && typeof data === "object" && "id" in data && "name" in data && "render" in data) {
      animRegistry.register(data as AsciiAnimationPiece);
      animPlayer?.sync();
      tui?.requestRender();
    }
  });

  function sectionRowCount(): number {
    const limit = (tui?.terminal.rows ?? 0) < 18 ? 1 : 3;
    let rows = 0;
    for (const id of ["mode", "scope", "account", "todo", "subagents", "artifacts"] as const) {
      const section = sections.get(id);
      if (!section || (!section.rows.length && (id === "subagents" || id === "account"))) continue;
      rows += (rows ? 1 : 0) + 1 + 1;
      if (id === "todo" && tui) {
        const maxLines = tui.terminal.rows < 18 ? 2 : 4;
        for (const row of section.rows.slice(0, limit)) {
          rows += wrapTodoRow(row, width - 2, maxLines).length;
        }
      } else {
        rows += Math.min(section.rows.length, limit);
      }
    }
    return rows;
  }

  function animatePiece(): boolean {
    const current = animRegistry.current;
    return active && enabled && animEnabled && tui?.mode === "fullscreen"
      && tui.terminal.columns >= SIDEBAR_MIN_COLUMNS
      && animationHeight(tui.terminal.rows, sectionRowCount(), current.maxHeight) > 0;
  }

  function resize(value: number) {
    if (value === width) return;
    width = value;
    mount?.updateWidth(value);
    tui?.requestRender(true);
  }

  function detach() {
    active = false;
    animPlayer?.dispose();
    animPlayer = undefined;
    resizer?.cancel();
    resizer = undefined;
    const owned = mount;
    mount = undefined;
    owned?.dispose();
    tui = undefined;
  }
  function cleanup() {
    detach();
    context?.ui.setWidget("workspace-sidebar", undefined);
    context = undefined;
    sections.clear();
  }

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    // Verified against this session's own file; an inherited `PI_SUBAGENT_SESSION`
    // from a Herdr pane's shell must not hide the sidebar on a normal start.
    if (ctx.mode !== "tui" || isSubagentChildSession(ctx)) return;
    context = ctx;
    ctx.ui.setWidget("workspace-sidebar", (renderer) => {
      tui = renderer;
      const player = new SidebarAnimationPlayer(animRegistry, animatePiece, () => renderer.requestRender());
      animPlayer = player;
      resizer = new SidebarResizer(
        () => renderer.terminal.columns,
        () => active && enabled && renderer.mode === "fullscreen" && renderer.terminal.columns >= SIDEBAR_MIN_COLUMNS,
        resize,
        () => animPlayer?.pause(),
        () => animPlayer?.resume()
      );
      const side: Component = {
        render(width) {
          const theme = ctx.ui.theme;
          const lines: string[] = [];
          const limit = renderer.terminal.rows < 18 ? 1 : 3;
          sectionBounds.clear();
          for (const id of ["mode", "scope", "account", "todo", "subagents", "artifacts"] as const) {
            const section = sections.get(id);
            if (!section || (!section.rows.length && (id === "subagents" || id === "account"))) continue;
            if (lines.length) lines.push("");
            const startLine = lines.length;
            const title = fit(section.title, width - 2);
            lines.push(theme.fg(section.tone ?? "accent", id === "mode" ? theme.bold(title) : title));
            if (id === "todo") {
              const maxLines = renderer.terminal.rows < 18 ? 2 : 4;
              for (const row of section.rows.slice(0, limit)) {
                lines.push(...wrapTodoRow(row, width - 2, maxLines));
              }
            } else {
              lines.push(...section.rows.slice(0, limit).map(row => fit(row, width - 2)));
            }
            lines.push(theme.fg("dim", fit(section.hint, width - 2)));
            sectionBounds.set(id, { start: startLine, end: lines.length - 1 });
          }
          const currentPiece = animRegistry.current;
          const animH = animEnabled ? animationHeight(renderer.terminal.rows, lines.length, currentPiece.maxHeight) : 0;
          if (animH && width - 2 >= 12) {
            lines.push("", theme.fg("accent", fit(currentPiece.name, width - 2)));
            const animStart = lines.length;
            const tankW = Math.min(SIDEBAR_MAX_WIDTH - 2, width - 2);
            // The scene contains trusted local glyphs and per-cell theme styling.
            lines.push(...player.render(tankW, animH, theme));
            const animEnd = lines.length - 1;
            animBounds = { start: animStart, end: animEnd, width: tankW };
          } else {
            animBounds = undefined;
          }
          const height = renderer.mode === "fullscreen" ? renderer.terminal.rows : Math.min(lines.length, renderer.terminal.rows);
          return Array.from({ length: Math.max(1, height) }, (_, row) =>
            `${theme.fg(resizer?.dragging ? "accent" : "dim", "│")} ${lines[row] ?? ""}`);
        },
        handleMouse(event) {
          const resizeResult = resizer?.handleMouse(event);
          if (resizeResult) return resizeResult;
          if ((event.type === "click" || event.type === "press") && event.x > 0) {
            // Aquarium top position feeding interaction
            if (animBounds && event.y >= animBounds.start - 1 && event.y <= animBounds.end) {
              const tankY = event.y - animBounds.start;
              const tankX = event.x - 2; // Column 0 is '│', column 1 is ' '
              // Click in top position of fish tank (title line, top rim, water surface, upper water)
              if (tankY <= 2 && tankX >= 1 && tankX <= animBounds.width - 2) {
                player.handleMouse?.(event, { x: 2, y: animBounds.start, width: animBounds.width, height: animBounds.end - animBounds.start + 1 });
                feedAquarium(tankX);
                return { handled: true, render: true };
              }
            }
            for (const [id, bounds] of sectionBounds) {
              if (event.y >= bounds.start && event.y <= bounds.end) {
                if (id === "todo") {
                  pi.events?.emit("workflow-todo:open-dialog", undefined);
                  return { handled: true, render: true };
                } else if (id === "subagents") {
                  pi.events?.emit("subagent-checkpoints:open-dialog", undefined);
                  return { handled: true, render: true };
                } else if (id === "account") {
                  pi.events?.emit("account-router:open", undefined);
                  return { handled: true, render: true };
                }
              }
            }
          }
        },
        invalidate() {},
      };
      mount = new SidebarMount(renderer, side, () => enabled, () => width);
      active = mount.ensure();
      if (active) { refresh(); player.sync(); }
      else ctx.ui.notify("Sidebar unavailable: this Pi version does not expose a compatible layout. Existing widgets remain enabled.", "warning");
      return {
        render(width) {
          // Pi's stable TUI reference can change renderer via /settings.
          // Reconcile on render; the animation only requests normal redraws.
          player.sync();
          if (active && !queued) {
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (mount && !mount.ensure()) {
                detach();
                refresh();
                ctx.ui.notify("Sidebar disabled: the new renderer has an unsupported layout. Original widgets restored.", "warning");
              }
            });
          }
          if (!active || !enabled || renderer.terminal.columns >= SIDEBAR_MIN_COLUMNS) return [];
          const text = ["mode", "account", "todo", "subagents", "artifacts"]
            .map(id => sections.get(id)?.title)
            .filter(Boolean).join(" · ");
          return text ? [ctx.ui.theme.fg("muted", fit(text, width))] : [];
        },
        invalidate() {},
        dispose: detach,
      };
    });
  });

  pi.on("session_tree", () => { sections.clear(); refresh(); });
  pi.on("session_shutdown", cleanup);

  pi.registerCommand("sidebar", {
    description: "Workspace sidebar: /sidebar [on|off|width 20–60|reset|anim [name|on|off]] (drag divider in fullscreen)",
    getArgumentCompletions(prefix: string) {
      const trimmed = prefix.trimStart().toLowerCase();

      // Subcommand: anim ...
      if (trimmed.startsWith("anim ") || trimmed === "anim") {
        const animOptions = [
          { value: "anim on", label: "anim on", description: "Enable sidebar animation" },
          { value: "anim off", label: "anim off", description: "Disable sidebar animation" },
          { value: "anim feed", label: "anim feed", description: "Feed aquarium biota (drop food at surface)" },
          ...animRegistry.list().map(piece => ({
            value: `anim ${piece.id}`,
            label: `anim ${piece.id}`,
            description: `${piece.name}${piece.description ? " — " + piece.description : ""}`,
          })),
        ];
        const matches = animOptions.filter(opt => opt.value.toLowerCase().startsWith(trimmed));
        return matches.length ? matches : animOptions;
      }

      // Subcommand: width ...
      if (trimmed.startsWith("width ") || trimmed === "width") {
        const widthOptions = [
          { value: "width 20", label: "width 20", description: "Minimum compact width (20 columns)" },
          { value: "width 24", label: "width 24", description: "Default width (24 columns)" },
          { value: "width 32", label: "width 32", description: "Medium width (32 columns)" },
          { value: "width 40", label: "width 40", description: "Wide width (40 columns)" },
          { value: "width 60", label: "width 60", description: "Maximum width (60 columns)" },
        ];
        const matches = widthOptions.filter(opt => opt.value.toLowerCase().startsWith(trimmed));
        return matches.length ? matches : widthOptions;
      }

      // Top-level options
      const topOptions = [
        { value: "on", label: "on", description: "Show workspace sidebar" },
        { value: "off", label: "off", description: "Hide workspace sidebar" },
        { value: "anim", label: "anim", description: `Configure animation (current: ${animRegistry.current.name})` },
        { value: "feed", label: "feed", description: "Feed aquarium biota (drop food at surface with gravity)" },
        { value: "width", label: "width", description: "Set sidebar width (20–60 columns)" },
        { value: "reset", label: "reset", description: "Reset sidebar width to default (24 columns)" },
      ];
      const matches = topOptions.filter(opt => opt.value.startsWith(trimmed));
      return matches.length ? matches : null;
    },
    async handler(args, ctx) {
      if (!active) { ctx.ui.notify("Sidebar is available in the main terminal UI only.", "info"); return; }
      const value = args.trim().toLowerCase();
      if (value === "feed" || value.startsWith("feed ") || value === "anim feed" || value.startsWith("anim feed ")) {
        const parts = value.split(/\s+/);
        const colStr = parts.at(-1);
        const col = colStr && /^\d+$/.test(colStr) ? parseInt(colStr, 10) : undefined;
        feedAquarium(col);
        tui?.requestRender();
        ctx.ui.notify("Fed the aquarium biota! Food is sinking under gravity 🐟🍽️", "info");
        return;
      }
      const animMatch = /^anim(?:\s+(.+))?$/.exec(value);
      if (animMatch || value === "anim") {
        const sub = animMatch?.[1]?.trim();
        if (!sub) {
          const current = animRegistry.current;
          const available = animRegistry.list().map(p => p.id === current.id ? `*${p.id}` : p.id).join(", ");
          ctx.ui.notify(`Active animation: ${current.name} (${animEnabled ? "on" : "off"}). Available: ${available}. Use /sidebar anim <name> to switch.`, "info");
          return;
        }
        if (sub === "on" || sub === "off") {
          animEnabled = sub === "on";
          animPlayer?.sync();
          tui?.requestRender();
          ctx.ui.notify(`Sidebar animation ${animEnabled ? "on" : "off"} (${animRegistry.current.name}).`, "info");
          return;
        }
        if (animRegistry.select(sub)) {
          animEnabled = true;
          animPlayer?.sync();
          tui?.requestRender();
          ctx.ui.notify(`Sidebar animation switched to ${animRegistry.current.name}.`, "info");
          return;
        }
        const available = animRegistry.list().map(p => p.id).join(", ");
        ctx.ui.notify(`Unknown animation "${sub}". Available: ${available}`, "warning");
        return;
      }
      const tankMatch = /^aquarium(?:\s+(on|off))?$/.exec(value);
      if (tankMatch) {
        if (tankMatch[1]) {
          animEnabled = tankMatch[1] === "on";
          if (animEnabled) animRegistry.select("aquarium");
        } else {
          animEnabled = !animEnabled;
        }
        animPlayer?.sync();
        tui?.requestRender();
        ctx.ui.notify(`Sidebar aquarium ${animEnabled ? "on" : "off"}.`, "info");
        return;
      }
      const widthMatch = /^width(?:\s+(\d+))?$/.exec(value);
      if (value === "reset" || widthMatch) {
        if (value === "reset" || widthMatch?.[1]) {
          const next = value === "reset" ? SIDEBAR_WIDTH : Number(widthMatch![1]);
          if (!Number.isInteger(next) || next < SIDEBAR_MIN_WIDTH || next > SIDEBAR_MAX_WIDTH) {
            ctx.ui.notify(`Sidebar width must be ${SIDEBAR_MIN_WIDTH}–${SIDEBAR_MAX_WIDTH} columns.`, "warning"); return;
          }
          resizer?.cancel();
          resize(next);
        }
        const columns = tui?.terminal.columns ?? 0;
        const actual = sidebarWidth(columns, width);
        const detail = columns < SIDEBAR_MIN_COLUMNS ? " (collapsed on this terminal)"
          : actual < width ? ` (${actual} visible to leave room for chat)` : "";
        ctx.ui.notify(`Sidebar width: ${width} columns${detail}.`, "info");
        return;
      }
      if (value && value !== "on" && value !== "off") {
        ctx.ui.notify("Usage: /sidebar [on|off|width 20–60|reset|anim [name|on|off]]", "warning"); return;
      }
      enabled = value ? value === "on" : !enabled;
      animPlayer?.sync();
      resizer?.cancel();
      tui?.invalidate();
      tui?.requestRender(true);
    },
  });
}
