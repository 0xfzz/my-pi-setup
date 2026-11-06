/** Version 1, experimental host-owned UI extension points. No browser code is accepted. */
export const WEB_UI_ANCHORS = [
  "app.header", "session.header", "session.sidebar", "chat.before", "chat.after",
  "chat.composer", "chat.working", "file-panel.header", "viewport.overlay",
] as const;
export const WEB_UI_REGIONS = ["top", "center", "bottom", "floating", "sidebar"] as const;
export const WEB_UI_COMPONENTS = {
  "ui.working-indicator.v1": { version: 1, model: "working", experimental: true },
  "ui.extension-status.v1": { version: 1, model: "status", experimental: true },
  "ui.plugin-view.v1": { version: 1, model: "view", experimental: true },
  "ui.session-sidebar-row.v1": { version: 1, model: "view", experimental: true },
  "ui.chat-before.v1": { version: 1, model: "view", experimental: true },
  "ui.floating-layer.v1": { version: 1, model: "view", experimental: true },
} as const;
export type WebUiAnchor = typeof WEB_UI_ANCHORS[number];
export type WebUiRegion = typeof WEB_UI_REGIONS[number];
export type WebUiComponent = keyof typeof WEB_UI_COMPONENTS;
export type WebPluginPlacement = (
  | { kind: "anchor"; anchor: WebUiAnchor }
  | { kind: "region"; region: WebUiRegion }
  | { kind: "overlay"; anchor?: WebUiAnchor; inset?: Partial<Record<"top" | "right" | "bottom" | "left", number>> }
) & {
  order?: number;
  minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number;
  mobileFallback?: WebUiAnchor;
  zIndex?: "base" | "raised" | "overlay";
  collision?: "stack" | "shrink" | "hide";
};
export interface WebPluginUiContribution {
  id: string;
  component: WebUiComponent;
  view?: string;
  strategy?: "default" | "compact" | "card";
  placement: WebPluginPlacement;
  priority?: number;
  scope: "session" | "project" | "global";
  visibleWhen?: "always" | "running" | "idle" | "has-view";
  override?: { target: WebUiComponent; mode: "replace" | "wrap" | "hide"; fallback: "builtin" };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(raw: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(raw).every(key => allowed.includes(key));
}
function integer(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
export function validatePlacement(input: unknown): Result<WebPluginPlacement> {
  if (!object(input) || !keys(input, ["kind", "anchor", "region", "inset", "order", "minWidth", "maxWidth", "minHeight", "maxHeight", "mobileFallback", "zIndex", "collision"])) {
    return { ok: false, error: "placement must contain only declared layout fields" };
  }
  const p = input;
  if (p.kind === "anchor") {
    if (!WEB_UI_ANCHORS.includes(p.anchor as WebUiAnchor) || p.region !== undefined || p.inset !== undefined) return { ok: false, error: "unknown anchor or invalid anchor fields" };
  } else if (p.kind === "region") {
    if (!WEB_UI_REGIONS.includes(p.region as WebUiRegion) || p.anchor !== undefined || p.inset !== undefined) return { ok: false, error: "unknown region or invalid region fields" };
  } else if (p.kind === "overlay") {
    // Overlays stay inside content containers, never app/auth/navigation controls.
    if (p.anchor !== undefined && !["viewport.overlay", "chat.before", "chat.after", "chat.composer", "chat.working"].includes(String(p.anchor))) return { ok: false, error: "unsafe overlay anchor" };
    if (p.region !== undefined || !integer(p.maxWidth, 1, 960) || !integer(p.maxHeight, 1, 720)) return { ok: false, error: "overlay requires bounded maxWidth/maxHeight" };
    if (p.inset !== undefined && (!object(p.inset) || !keys(p.inset, ["top", "right", "bottom", "left"]) || !Object.values(p.inset).every(n => integer(n, 0, 512)))) return { ok: false, error: "invalid overlay inset" };
  } else return { ok: false, error: "unknown placement kind" };
  for (const field of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
    if (p[field] !== undefined && !integer(p[field], 1, 4096)) return { ok: false, error: `invalid dimension ${field}` };
  }
  if ((typeof p.minWidth === "number" && typeof p.maxWidth === "number" && p.minWidth > p.maxWidth) || (typeof p.minHeight === "number" && typeof p.maxHeight === "number" && p.minHeight > p.maxHeight)) return { ok: false, error: "minimum dimension exceeds maximum" };
  if (p.order !== undefined && !integer(p.order, -1000, 1000)) return { ok: false, error: "invalid order" };
  if (p.mobileFallback !== undefined && !WEB_UI_ANCHORS.includes(p.mobileFallback as WebUiAnchor)) return { ok: false, error: "unknown mobile fallback anchor" };
  if (p.zIndex !== undefined && !["base", "raised", "overlay"].includes(String(p.zIndex))) return { ok: false, error: "invalid z-index class" };
  if (p.collision !== undefined && !["stack", "shrink", "hide"].includes(String(p.collision))) return { ok: false, error: "invalid collision behavior" };
  return { ok: true, value: structuredClone(p) as WebPluginPlacement };
}

export function validateContributions(input: unknown, pluginId: string): Result<WebPluginUiContribution[]> {
  if (!Array.isArray(input) || input.length > 32) return { ok: false, error: `Plugin "${pluginId}": ui must be an array of at most 32 contributions` };
  const ids = new Set<string>();
  const clean: WebPluginUiContribution[] = [];
  for (const entry of input) {
    const name = object(entry) && typeof entry.id === "string" ? entry.id : "unknown";
    const fail = (reason: string): Result<WebPluginUiContribution[]> => ({ ok: false, error: `Plugin "${pluginId}" contribution "${name}": ${reason}` });
    if (!object(entry) || !keys(entry, ["id", "component", "view", "strategy", "placement", "priority", "scope", "visibleWhen", "override"])) return fail("unknown contribution fields");
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id)) return fail("invalid or duplicate contribution id");
    ids.add(entry.id);
    if (typeof entry.component !== "string" || !Object.hasOwn(WEB_UI_COMPONENTS, entry.component)) return fail("unknown component key/schema version");
    if (!["session", "project", "global"].includes(String(entry.scope))) return fail("explicit scope required");
    if (entry.priority !== undefined && !integer(entry.priority, -1000, 1000)) return fail("invalid priority");
    if (entry.strategy !== undefined && !["default", "compact", "card"].includes(String(entry.strategy))) return fail("unknown host render strategy");
    if (entry.view !== undefined && (typeof entry.view !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.view))) return fail("invalid view key");
    if (entry.visibleWhen !== undefined && !["always", "running", "idle", "has-view"].includes(String(entry.visibleWhen))) return fail("invalid visibility");
    if (entry.override !== undefined) {
      const o = entry.override;
      if (!object(o) || !keys(o, ["target", "mode", "fallback"]) || !Object.hasOwn(WEB_UI_COMPONENTS, String(o.target)) || !["replace", "wrap", "hide"].includes(String(o.mode)) || o.fallback !== "builtin") return fail("unsafe override target/mode or missing builtin fallback");
      if (entry.component !== o.target) return fail("override model/schema must match target component");
    }
    const placement = validatePlacement(entry.placement);
    if (!placement.ok) return fail(placement.error);
    clean.push({ ...structuredClone(entry), placement: placement.value } as unknown as WebPluginUiContribution);
  }
  return { ok: true, value: clean };
}

export function normalizeContributions(plugin: { ui?: WebPluginUiContribution[]; surfaces: readonly { kind: string; slot?: string }[] }): WebPluginUiContribution[] {
  if (plugin.ui !== undefined) return plugin.ui;
  return plugin.surfaces.flatMap((s, index) => s.kind === "slot" ? [{
    id: `legacy-${index}`, component: "ui.plugin-view.v1" as const, scope: "session" as const,
    placement: { kind: "region" as const, region: s.slot as WebUiRegion },
  }] : []);
}
export interface OwnedContribution { pluginId: string; contribution: WebPluginUiContribution }
export function resolveOverrides(target: WebUiComponent, entries: readonly OwnedContribution[], disabled: ReadonlySet<string> = new Set(), userChoice?: string): { replacement?: OwnedContribution; wrappers: OwnedContribution[]; hidden: boolean } {
  const candidates = entries.filter(e => e.contribution.override?.target === target && !disabled.has(`${e.pluginId}/${e.contribution.id}`))
    .sort((a, b) => (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0) || `${a.pluginId}/${a.contribution.id}`.localeCompare(`${b.pluginId}/${b.contribution.id}`));
  const replacement = candidates.find(e => `${e.pluginId}/${e.contribution.id}` === userChoice && e.contribution.override?.mode !== "wrap") ?? candidates.find(e => e.contribution.override?.mode !== "wrap");
  return { replacement, wrappers: candidates.filter(e => e.contribution.override?.mode === "wrap"), hidden: replacement?.contribution.override?.mode === "hide" };
}
