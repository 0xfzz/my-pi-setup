import { validateActions, type ActionDescriptor } from "./web-ui-actions.ts";
import { validateContributions, type WebPluginUiContribution } from "./web-ui-contracts.ts";

export type { ActionDescriptor } from "./web-ui-actions.ts";

export type WebPluginSlot = "top" | "center" | "bottom" | "floating";

export const VALID_SLOTS: readonly WebPluginSlot[] = [
  "top",
  "center",
  "bottom",
  "floating",
];

export type WebPluginSurface =
  | { kind: "sidebar" }
  | { kind: "page"; path: string }
  | { kind: "slot"; slot: WebPluginSlot };

export interface WebPluginDescriptor {
  id: string;
  extension: string;
  title: string;
  surfaces: WebPluginSurface[];
  ui?: WebPluginUiContribution[];
  description?: string;
  actions?: ActionDescriptor[];
}

export type ValidatePluginResult =
  | { ok: true; plugin: WebPluginDescriptor }
  | { ok: false; error: string };

const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const PAGE_PATH_REGEX = /^\/plugins\/[a-z0-9\-/]*$/;

export function validatePlugin(
  input: unknown,
  knownExtensions: readonly string[],
): ValidatePluginResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: 'Plugin "unknown": descriptor must be a non-null object' };
    }

    const raw = input as Record<string, unknown>;
    const pluginName =
      typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : "unknown";

    if (typeof raw.id !== "string" || !PLUGIN_ID_REGEX.test(raw.id)) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": id must match ^[a-z][a-z0-9-]*$`,
      };
    }

    if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": title is missing or empty`,
      };
    }

    if (typeof raw.extension !== "string" || raw.extension.trim().length === 0) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": extension is missing or empty`,
      };
    }

    const normalizedKnown = new Set(
      knownExtensions.map((e) => (e.endsWith(".ts") ? e : `${e}.ts`)),
    );
    const expectedFile = raw.extension.endsWith(".ts")
      ? raw.extension
      : `${raw.extension}.ts`;

    if (!normalizedKnown.has(expectedFile)) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": unknown extension "${raw.extension}", missing file extensions/${expectedFile}`,
      };
    }

    if (!Array.isArray(raw.surfaces) || (raw.surfaces.length === 0 && (!Array.isArray(raw.ui) || raw.ui.length === 0))) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": must have at least one surface`,
      };
    }

    const cleanSurfaces: WebPluginSurface[] = [];
    for (let i = 0; i < raw.surfaces.length; i++) {
      const surface = raw.surfaces[i];
      if (typeof surface !== "object" || surface === null || Array.isArray(surface)) {
        return {
          ok: false,
          error: `Plugin "${pluginName}": surface at index ${i} must be an object`,
        };
      }

      const s = surface as Record<string, unknown>;
      if (s.kind === "sidebar") {
        cleanSurfaces.push({ kind: "sidebar" });
      } else if (s.kind === "page") {
        if (
          typeof s.path !== "string" ||
          !s.path.startsWith("/plugins/") ||
          !PAGE_PATH_REGEX.test(s.path)
        ) {
          return {
            ok: false,
            error: `Plugin "${pluginName}": invalid page path "${String(s.path)}"`,
          };
        }
        cleanSurfaces.push({ kind: "page", path: s.path });
      } else if (s.kind === "slot") {
        if (
          typeof s.slot !== "string" ||
          !VALID_SLOTS.includes(s.slot as WebPluginSlot)
        ) {
          return {
            ok: false,
            error: `Plugin "${pluginName}": invalid slot "${String(s.slot)}"`,
          };
        }
        cleanSurfaces.push({ kind: "slot", slot: s.slot as WebPluginSlot });
      } else {
        return {
          ok: false,
          error: `Plugin "${pluginName}": unknown surface kind "${String(s.kind)}"`,
        };
      }
    }

    if (raw.description !== undefined && typeof raw.description !== "string") {
      return {
        ok: false,
        error: `Plugin "${pluginName}": description must be a string`,
      };
    }

    let cleanActions: ActionDescriptor[] | undefined;
    if (raw.actions !== undefined) {
      const actionsResult = validateActions(raw.actions);
      if (!actionsResult.ok) {
        return {
          ok: false,
          error: `Plugin "${pluginName}": ${actionsResult.error}`,
        };
      }
      cleanActions = actionsResult.actions;
    }

    const ui = raw.ui === undefined ? undefined : validateContributions(raw.ui, pluginName);
    if (ui && !ui.ok) return { ok: false, error: ui.error };

    const plugin: WebPluginDescriptor = {
      id: raw.id,
      extension: raw.extension,
      title: raw.title,
      surfaces: cleanSurfaces,
      ...(ui?.ok ? { ui: ui.value } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(cleanActions !== undefined ? { actions: cleanActions } : {}),
    };

    return { ok: true, plugin };
  } catch (err) {
    return {
      ok: false,
      error: `Plugin "unknown": validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
