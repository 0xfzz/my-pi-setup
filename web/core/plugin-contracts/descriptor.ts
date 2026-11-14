import { validateActions, type ActionDescriptor } from "./actions.ts";
import { validateContributions, type WebPluginUiContribution } from "./ui-contracts.ts";

export type { ActionDescriptor } from "./actions.ts";

/**
 * Host regions the shell owns and a plugin may replace outright: the app
 * header, its status area, the transcript, and the composer.
 */
export type HostRegion = "header" | "status" | "transcript" | "composer";

export const HOST_REGIONS: readonly HostRegion[] = [
  "header",
  "status",
  "transcript",
  "composer",
];

/**
 * What a plugin *is*, as opposed to where its views mount.
 *
 * Placement lives in exactly one place — `ui[].placement`. A surface never
 * repeats it; it only claims a non-placement role:
 *
 * - `sidebar`  — the plugin has a right-hand panel (the panel is its home;
 *                the host never duplicates that view into a chat slot).
 * - `page`     — the plugin owns the route `/plugins/<id>`.
 * - `dialog`   — the plugin publishes modal views (`type: "dialog"`), which
 *                the host renders in its single dialog layer.
 * - `override` — while the plugin has a view published, it replaces that
 *                host region.
 */
export type WebPluginSurface =
  | { kind: "sidebar" }
  | { kind: "page"; path: string }
  | { kind: "dialog" }
  | { kind: "override"; region: HostRegion };

const PLUGIN_ICONS = [
  "files", "list-checks", "tree-structure", "users",
  "chart-bar", "sliders", "spinner", "puzzle-piece",
] as const;

/** Host-rendered symbols only: plugins never supply SVG, HTML, or URLs. */
export type WebPluginIcon = (typeof PLUGIN_ICONS)[number];

function isPluginIcon(value: unknown): value is WebPluginIcon {
  return PLUGIN_ICONS.some((icon) => icon === value);
}

export interface WebPluginDescriptor {
  id: string;
  extension: string;
  title: string;
  icon?: WebPluginIcon;
  /** Where each of the plugin's views mounts. The only placement language. */
  ui?: WebPluginUiContribution[];
  /** Non-placement claims: panel, page route, dialog publisher, region override. */
  surfaces: WebPluginSurface[];
  description?: string;
  actions?: ActionDescriptor[];
  /**
   * True when the plugin's panel renders from session context alone (e.g. the
   * session workspace files) rather than waiting for a published WebView.
   * Still requires an active session.
   */
  sessionPanel?: boolean;
  /**
   * True when the plugin's action ids are chosen at runtime (the web core
   * channel's `fork@<entryId>`), so the descriptor cannot list them and the
   * extension that published the view is the validator.
   */
  dynamicActions?: boolean;
}

export type ValidatePluginResult =
  | { ok: true; plugin: WebPluginDescriptor }
  | { ok: false; error: string };

const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const PAGE_PATH_REGEX = /^\/plugins\/[a-z0-9.\-/]*$/;

type SurfaceResult =
  | { ok: true; surface: WebPluginSurface }
  | { ok: false; error: string };

/** One surface, narrowed to its declared shape. Unknown kinds are refused. */
function validateSurface(raw: unknown, index: number, pluginName: string): SurfaceResult {
  const fail = (reason: string): SurfaceResult => ({
    ok: false,
    error: `Plugin "${pluginName}": ${reason}`,
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(`surface at index ${index} must be an object`);
  }
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case "sidebar":
      return { ok: true, surface: { kind: "sidebar" } };
    case "dialog":
      return { ok: true, surface: { kind: "dialog" } };
    case "page":
      if (typeof s.path !== "string" || !s.path.startsWith("/plugins/") || !PAGE_PATH_REGEX.test(s.path)) {
        return fail(`invalid page path "${String(s.path)}"`);
      }
      return { ok: true, surface: { kind: "page", path: s.path } };
    case "override":
      if (typeof s.region !== "string" || !HOST_REGIONS.includes(s.region as HostRegion)) {
        return fail(`invalid override region "${String(s.region)}"`);
      }
      return { ok: true, surface: { kind: "override", region: s.region as HostRegion } };
    default:
      return fail(`unknown surface kind "${String(s.kind)}"`);
  }
}

function validateSurfaces(raw: unknown, pluginName: string): { ok: true; surfaces: WebPluginSurface[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `Plugin "${pluginName}": surfaces must be an array` };
  }
  const surfaces: WebPluginSurface[] = [];
  for (let i = 0; i < raw.length; i++) {
    const result = validateSurface(raw[i], i, pluginName);
    if (!result.ok) return result;
    surfaces.push(result.surface);
  }
  return { ok: true, surfaces };
}

export function validatePlugin(input: unknown): ValidatePluginResult {
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
        error: `Plugin "${pluginName}": id must match ^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$`,
      };
    }

    if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": title is missing or empty`,
      };
    }

    if (raw.icon !== undefined && !isPluginIcon(raw.icon)) {
      return { ok: false, error: `Plugin "${pluginName}": icon must be a supported host icon` };
    }

    if (typeof raw.extension !== "string" || raw.extension.trim().length === 0) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": extension is missing or empty`,
      };
    }

    const surfacesResult = validateSurfaces(raw.surfaces ?? [], pluginName);
    if (!surfacesResult.ok) return surfacesResult;
    const surfaces = surfacesResult.surfaces;

    if (surfaces.length === 0 && (!Array.isArray(raw.ui) || raw.ui.length === 0)) {
      return {
        ok: false,
        error: `Plugin "${pluginName}": must have at least one surface`,
      };
    }

    if (raw.description !== undefined && typeof raw.description !== "string") {
      return {
        ok: false,
        error: `Plugin "${pluginName}": description must be a string`,
      };
    }

    for (const flag of ["sessionPanel", "dynamicActions"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
        return { ok: false, error: `Plugin "${pluginName}": ${flag} must be a boolean` };
      }
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
      ...(isPluginIcon(raw.icon) ? { icon: raw.icon } : {}),
      surfaces,
      ...(ui?.ok ? { ui: ui.value } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(cleanActions !== undefined ? { actions: cleanActions } : {}),
      ...(typeof raw.sessionPanel === "boolean" ? { sessionPanel: raw.sessionPanel } : {}),
      ...(typeof raw.dynamicActions === "boolean" ? { dynamicActions: raw.dynamicActions } : {}),
    };

    return { ok: true, plugin };
  } catch (err) {
    return {
      ok: false,
      error: `Plugin "unknown": validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
