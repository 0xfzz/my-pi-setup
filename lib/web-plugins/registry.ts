import { readdirSync } from "node:fs";
import { join } from "node:path";
import { validatePlugin, type WebPluginDescriptor } from "./descriptor.ts";

export { WEB_PLUGIN_VIEW_EVENT } from "./view.ts";
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
  }

  return errors;
}
