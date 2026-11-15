import { validateView, type DialogWebView } from "../plugin-contracts/view.ts";

/** The slice of an announced web command this module reasons about. */
export interface SettingsCommandLike {
  name?: string;
  managesModels?: boolean;
  settingsPlugin?: string;
}

/** Settings pages name their publisher; plugin catalogue visibility is unrelated. */
export function settingsDialog(
  command: { settingsPlugin?: string } | undefined,
  views: Readonly<Record<string, unknown>>,
): { pluginId: string; view: DialogWebView } | undefined {
  const pluginId = command?.settingsPlugin;
  if (pluginId === undefined) return undefined;
  const result = validateView(views[pluginId]);
  if (!result.ok || result.view.type !== "dialog") return undefined;
  return { pluginId, view: result.view };
}

/**
 * The plugins whose dialogs belong to the model-settings surface.
 *
 * A command that announces `settingsPlugin` is saying "my dialog renders in
 * the model-settings pane", so those views have exactly one home. The
 * standalone dialog layer must never draw them: a wizard parked in the pane
 * would otherwise pop out as a floating modal the moment the pane closes —
 * after Escape, a backdrop click, or a reload that replays the view.
 */
export function settingsPluginIds(commands: readonly SettingsCommandLike[] | undefined): string[] {
  return (commands ?? []).flatMap((command) =>
    command.managesModels === true && command.settingsPlugin !== undefined ? [command.settingsPlugin] : [],
  );
}

/**
 * Whether opening a settings page has to ask its extension to publish.
 *
 * A page whose extension already has an open dialog is mid-wizard: dispatching
 * the command again would restart the flow and throw away the answers the user
 * is in the middle of giving, so the pane renders what is already there. A
 * closed (`open: false`) or absent view is a fresh start.
 */
export function needsSettingsDispatch(
  dialog: { view: Pick<DialogWebView, "open"> } | undefined,
): boolean {
  return dialog === undefined || dialog.view.open === false;
}
