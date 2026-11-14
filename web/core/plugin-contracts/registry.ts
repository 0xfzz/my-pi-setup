import { validatePlugin, type WebPluginDescriptor } from "./descriptor.ts";
import { contributionsOf, type WebPluginUiContribution } from "./ui-contracts.ts";

export { WEB_PLUGIN_VIEW_EVENT } from "./view.ts";
export {
  WEB_PLUGIN_ACTION_REQUEST_EVENT,
  type ActionDescriptor,
  type ActionRequestPayload,
  validateActions,
} from "./actions.ts";
export type { WebPluginDescriptor, WebPluginSurface } from "./descriptor.ts";

/** The slot two plugins contend for: one target at one priority. */
function exclusiveReplacementKey(contribution: WebPluginUiContribution): string | undefined {
  const target = contribution.override?.target;
  return target === undefined ? undefined : `${target}/${contribution.priority ?? 0}`;
}

/**
 * Cross-plugin checks that no single descriptor can make: duplicate ids,
 * duplicate page paths, duplicate action ids, and two plugins claiming the
 * same exclusive replacement at the same priority.
 *
 * Returns the problems as messages, so a caller can decide whether a bad
 * registry is fatal (a test) or a warning (a booting host).
 */
export function validateRegistry(plugins: readonly WebPluginDescriptor[]): string[] {
  if (!Array.isArray(plugins)) return ["plugins must be an array"];

  const errors: string[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const replacements = new Map<string, string>();

  for (const plugin of plugins) {
    const pluginResult = validatePlugin(plugin);
    if (!pluginResult.ok) {
      errors.push(pluginResult.error);
      continue;
    }

    for (const contribution of contributionsOf(pluginResult.plugin)) {
      if (contribution.override === undefined || contribution.override.mode === "wrap") continue;
      const key = exclusiveReplacementKey(contribution);
      if (key === undefined) continue;
      const owner = `${plugin.id}/${contribution.id}`;
      const existing = replacements.get(key);
      if (existing !== undefined) {
        errors.push(`Plugin "${plugin.id}" contribution "${contribution.id}": conflicting exclusive replacement with ${existing}`);
      } else {
        replacements.set(key, owner);
      }
    }

    if (seenIds.has(plugin.id)) errors.push(`Duplicate plugin id: "${plugin.id}"`);
    else seenIds.add(plugin.id);

    for (const surface of plugin.surfaces) {
      if (surface.kind !== "page") continue;
      if (seenPaths.has(surface.path)) errors.push(`Duplicate page path: "${surface.path}"`);
      else seenPaths.add(surface.path);
    }

    const seenActionIds = new Set<string>();
    for (const action of plugin.actions ?? []) {
      if (seenActionIds.has(action.id)) errors.push(`Plugin "${plugin.id}": duplicate action id "${action.id}"`);
      else seenActionIds.add(action.id);
    }
  }

  return errors;
}
