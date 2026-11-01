import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { PopupPanel, popupOverlayOptions, isPopupCloseKey } from "./popup.ts";

export const WORKFLOW_PREFIX = "alt+w";
export const TODO_DETAILS_HINT = "Alt+W → T · details";
export const SUBAGENT_DETAILS_HINT = "Alt+W → S · details";

type Action = "todos" | "subagents" | "artifacts";

/** A focused prefix screen, not an editor input hook: action keys cannot leak
 * into the draft, and no global timer/listener survives dismissal or reload. */
export function registerWorkflowActions(pi: ExtensionAPI) {
  let open = false;
  async function show(ctx: ExtensionContext) {
    if (open || !ctx.hasUI) return;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Use /workflow-todos, /subagents, or /artifacts for details.", "info");
      return;
    }
    open = true;
    let action: Action | undefined;
    try {
      action = await ctx.ui.custom<Action | undefined>((_tui, theme, _keys, done) => {
        const panel = new PopupPanel({
          theme,
          title: "Workflow · Alt+W",
          hint: "Esc close",
          onKey(data) {
            if (matchesKey(data, "t") || matchesKey(data, "shift+t")) done("todos");
            else if (matchesKey(data, "s") || matchesKey(data, "shift+s")) done("subagents");
            else if (matchesKey(data, "e") || matchesKey(data, "shift+e")) done("artifacts");
            else if (isPopupCloseKey(data)) done(undefined);
          },
        });
        panel.setContent([
          "T  Todo details",
          "S  Subagent details",
          "E  Artifact details",
          theme.fg("dim", "T / S / E to select · Esc close"),
        ]);
        return panel;
      }, { overlay: true, overlayOptions: popupOverlayOptions(38, 28, 10) as any });
    } finally {
      open = false;
    }
    // Close the prefix UI before opening the destination to preserve focus.
    if (action === "todos") {
      pi.events.emit("workflow-todo:open-dialog", undefined);
    } else if (action === "subagents") {
      pi.events.emit("subagent-checkpoints:open-dialog", undefined);
    } else if (action === "artifacts") {
      pi.events.emit("artifacts:open-dialog", undefined);
    }
  }

  pi.registerShortcut(WORKFLOW_PREFIX, { description: "Workflow prefix: T todos, S subagents, E artifacts", handler: show });
  pi.registerCommand("workflow", { description: "Workflow action menu (Alt+W, then T/S/E)", handler: (_args, ctx) => show(ctx) });
}
