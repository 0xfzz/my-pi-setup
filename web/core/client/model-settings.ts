import { validateView, type DialogWebView } from "../plugin-contracts/view.ts";

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
