import { readdirSync } from "node:fs";
import { join } from "node:path";
import { validatePlugin, type WebPluginDescriptor } from "./descriptor.ts";

export { WEB_PLUGIN_VIEW_EVENT } from "./view.ts";
export {
  WEB_PLUGIN_ACTION_REQUEST_EVENT,
  type ActionDescriptor,
  type ActionRequestPayload,
  validateActions,
} from "./actions.ts";
export type { WebPluginDescriptor, WebPluginSurface } from "./descriptor.ts";

function getDefaultExtensions(): string[] {
  try {
    const cwdPath = join(process.cwd(), "extensions");
    const files = readdirSync(cwdPath).filter((f) => f.endsWith(".ts"));
    if (files.length > 0) return files;
  } catch {
    // try fallback below
  }
  try {
    const metaDir = join(new URL(".", import.meta.url).pathname, "../../extensions");
    return readdirSync(metaDir).filter((f) => f.endsWith(".ts"));
  } catch {
    return [];
  }
}

export function validateRegistry(
  plugins: readonly WebPluginDescriptor[],
  knownExtensions?: readonly string[],
): string[] {
  if (!Array.isArray(plugins)) {
    return ["plugins must be an array"];
  }

  const errors: string[] = [];
  const known = knownExtensions ?? getDefaultExtensions();

  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const plugin of plugins) {
    const pluginResult = validatePlugin(plugin, known);
    if (!pluginResult.ok) {
      errors.push(pluginResult.error);
    }

    if (plugin && typeof plugin.id === "string") {
      if (seenIds.has(plugin.id)) {
        errors.push(`Duplicate plugin id: "${plugin.id}"`);
      } else {
        seenIds.add(plugin.id);
      }
    }

    if (plugin && Array.isArray(plugin.surfaces)) {
      for (const surface of plugin.surfaces) {
        if (surface && surface.kind === "page" && typeof surface.path === "string") {
          if (seenPaths.has(surface.path)) {
            errors.push(`Duplicate page path: "${surface.path}"`);
          } else {
            seenPaths.add(surface.path);
          }
        }
      }
    }

    if (plugin && Array.isArray(plugin.actions)) {
      const seenActionIds = new Set<string>();
      for (const action of plugin.actions) {
        if (action && typeof action.id === "string") {
          if (seenActionIds.has(action.id)) {
            errors.push(`Plugin "${plugin.id}": duplicate action id "${action.id}"`);
          } else {
            seenActionIds.add(action.id);
          }
        }
      }
    }
  }

  return errors;
}
