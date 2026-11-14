/**
 * Version 1, experimental host-owned UI extension points. No browser code is
 * accepted: a plugin names a host anchor or a host component, and the host
 * decides how to render it.
 *
 * Two vocabularies, each with one meaning:
 * - an ANCHOR is a named spot in the shell (`chat.composer`, `session.header`);
 *   every anchor here has an `AnchorHost` mounting it.
 * - a COMPONENT is a host-owned widget whose model the plugin supplies. Only
 *   the components in `OVERRIDABLE_COMPONENTS` have a `ComponentOverrideHost`,
 *   so only those may be named as an override target.
 */

export const WEB_UI_ANCHORS = [
  "app.header", "session.header", "session.sidebar", "chat.before", "chat.after",
  "chat.composer", "chat.working", "file-panel.header", "viewport.overlay",
] as const;

export const WEB_UI_REGIONS = ["top", "center", "bottom", "floating", "sidebar"] as const;

/** Host widgets a plugin may supply a model for. */
export const WEB_UI_COMPONENTS = {
  "ui.working-indicator.v1": { version: 1, model: "working", experimental: true },
  "ui.extension-status.v1": { version: 1, model: "status", experimental: true },
  "ui.plugin-view.v1": { version: 1, model: "view", experimental: true },
} as const;

/**
 * Components the shell wraps in a `ComponentOverrideHost`. Naming a target
 * outside this list would be a declaration nothing mounts, so the validator
 * refuses it.
 */
export const OVERRIDABLE_COMPONENTS = [
  "ui.working-indicator.v1",
  "ui.extension-status.v1",
] as const;

export type WebUiAnchor = typeof WEB_UI_ANCHORS[number];
export type WebUiRegion = typeof WEB_UI_REGIONS[number];
export type WebUiComponent = keyof typeof WEB_UI_COMPONENTS;
export type OverridableComponent = typeof OVERRIDABLE_COMPONENTS[number];

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
  override?: { target: OverridableComponent; mode: "replace" | "wrap" | "hide"; fallback: "builtin" };
}

export interface OwnedContribution {
  pluginId: string;
  contribution: WebPluginUiContribution;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const CONTRIBUTION_FIELDS = [
  "id", "component", "view", "strategy", "placement", "priority", "scope", "visibleWhen", "override",
];
const PLACEMENT_FIELDS = [
  "kind", "anchor", "region", "inset", "order", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "mobileFallback", "zIndex", "collision",
];
/** Overlays stay inside content containers, never app/auth/navigation controls. */
const OVERLAY_ANCHORS: readonly WebUiAnchor[] = [
  "viewport.overlay", "chat.before", "chat.after", "chat.composer", "chat.working",
];
const DIMENSION_FIELDS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
const MAX_CONTRIBUTIONS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((key) => allowed.includes(key));
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isDimensionPairOrdered(raw: Record<string, unknown>): boolean {
  const minWidth = raw.minWidth;
  const maxWidth = raw.maxWidth;
  const minHeight = raw.minHeight;
  const maxHeight = raw.maxHeight;
  const widthOrdered = typeof minWidth !== "number" || typeof maxWidth !== "number" || minWidth <= maxWidth;
  const heightOrdered = typeof minHeight !== "number" || typeof maxHeight !== "number" || minHeight <= maxHeight;
  return widthOrdered && heightOrdered;
}

function validateAnchorPlacement(p: Record<string, unknown>): string | undefined {
  if (!includes(WEB_UI_ANCHORS, p.anchor) || p.region !== undefined || p.inset !== undefined) {
    return "unknown anchor or invalid anchor fields";
  }
  return undefined;
}

function validateRegionPlacement(p: Record<string, unknown>): string | undefined {
  if (!includes(WEB_UI_REGIONS, p.region) || p.anchor !== undefined || p.inset !== undefined) {
    return "unknown region or invalid region fields";
  }
  return undefined;
}

function validateInset(inset: unknown): boolean {
  return isRecord(inset)
    && onlyKeys(inset, ["top", "right", "bottom", "left"])
    && Object.values(inset).every((n) => isIntegerIn(n, 0, 512));
}

function validateOverlayPlacement(p: Record<string, unknown>): string | undefined {
  if (p.anchor !== undefined && !OVERLAY_ANCHORS.includes(p.anchor as WebUiAnchor)) {
    return "unsafe overlay anchor";
  }
  if (p.region !== undefined || !isIntegerIn(p.maxWidth, 1, 960) || !isIntegerIn(p.maxHeight, 1, 720)) {
    return "overlay requires bounded maxWidth/maxHeight";
  }
  if (p.inset !== undefined && !validateInset(p.inset)) return "invalid overlay inset";
  return undefined;
}

function validatePlacementShape(p: Record<string, unknown>): string | undefined {
  switch (p.kind) {
    case "anchor": return validateAnchorPlacement(p);
    case "region": return validateRegionPlacement(p);
    case "overlay": return validateOverlayPlacement(p);
    default: return "unknown placement kind";
  }
}

export function validatePlacement(input: unknown): Result<WebPluginPlacement> {
  if (!isRecord(input) || !onlyKeys(input, PLACEMENT_FIELDS)) {
    return { ok: false, error: "placement must contain only declared layout fields" };
  }
  const shapeError = validatePlacementShape(input);
  if (shapeError !== undefined) return { ok: false, error: shapeError };

  for (const field of DIMENSION_FIELDS) {
    if (input[field] !== undefined && !isIntegerIn(input[field], 1, 4096)) {
      return { ok: false, error: `invalid dimension ${field}` };
    }
  }
  if (!isDimensionPairOrdered(input)) return { ok: false, error: "minimum dimension exceeds maximum" };
  if (input.order !== undefined && !isIntegerIn(input.order, -1000, 1000)) return { ok: false, error: "invalid order" };
  if (input.mobileFallback !== undefined && !includes(WEB_UI_ANCHORS, input.mobileFallback)) {
    return { ok: false, error: "unknown mobile fallback anchor" };
  }
  if (input.zIndex !== undefined && !["base", "raised", "overlay"].includes(String(input.zIndex))) {
    return { ok: false, error: "invalid z-index class" };
  }
  if (input.collision !== undefined && !["stack", "shrink", "hide"].includes(String(input.collision))) {
    return { ok: false, error: "invalid collision behavior" };
  }
  return { ok: true, value: structuredClone(input) as WebPluginPlacement };
}

function validateOverride(input: unknown, component: unknown): string | undefined {
  if (!isRecord(input) || !onlyKeys(input, ["target", "mode", "fallback"])) {
    return "unsafe override target/mode or missing builtin fallback";
  }
  if (!includes(OVERRIDABLE_COMPONENTS, input.target)) return "override target has no host to override";
  if (!["replace", "wrap", "hide"].includes(String(input.mode))) return "unknown override mode";
  if (input.fallback !== "builtin") return "unsafe override target/mode or missing builtin fallback";
  if (component !== input.target) return "override model/schema must match target component";
  return undefined;
}

const CONTRIBUTION_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const VIEW_KEY_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

function validateContribution(input: unknown, pluginId: string): Result<WebPluginUiContribution> {
  const name = isRecord(input) && typeof input.id === "string" ? input.id : "unknown";
  const fail = (reason: string): Result<WebPluginUiContribution> => ({
    ok: false,
    error: `Plugin "${pluginId}" contribution "${name}": ${reason}`,
  });
  if (!isRecord(input) || !onlyKeys(input, CONTRIBUTION_FIELDS)) return fail("unknown contribution fields");
  if (!includes(Object.keys(WEB_UI_COMPONENTS), input.component)) {
    return fail("unknown component key/schema version");
  }
  if (!["session", "project", "global"].includes(String(input.scope))) return fail("explicit scope required");
  if (input.priority !== undefined && !isIntegerIn(input.priority, -1000, 1000)) return fail("invalid priority");
  if (input.strategy !== undefined && !["default", "compact", "card"].includes(String(input.strategy))) {
    return fail("unknown host render strategy");
  }
  if (input.view !== undefined && (typeof input.view !== "string" || !VIEW_KEY_REGEX.test(input.view))) {
    return fail("invalid view key");
  }
  if (input.visibleWhen !== undefined && !["always", "running", "idle", "has-view"].includes(String(input.visibleWhen))) {
    return fail("invalid visibility");
  }
  if (input.override !== undefined) {
    const overrideError = validateOverride(input.override, input.component);
    if (overrideError !== undefined) return fail(overrideError);
  }
  const placement = validatePlacement(input.placement);
  if (!placement.ok) return fail(placement.error);
  return { ok: true, value: { ...structuredClone(input), placement: placement.value } as WebPluginUiContribution };
}

export function validateContributions(input: unknown, pluginId: string): Result<WebPluginUiContribution[]> {
  if (!Array.isArray(input) || input.length > MAX_CONTRIBUTIONS) {
    return { ok: false, error: `Plugin "${pluginId}": ui must be an array of at most ${MAX_CONTRIBUTIONS} contributions` };
  }
  const seen = new Set<string>();
  const clean: WebPluginUiContribution[] = [];
  for (const entry of input) {
    const result = validateContribution(entry, pluginId);
    if (!result.ok) return result;
    const id = result.value.id;
    if (!CONTRIBUTION_ID_REGEX.test(id) || seen.has(id)) {
      return { ok: false, error: `Plugin "${pluginId}" contribution "${id}": invalid or duplicate contribution id` };
    }
    seen.add(id);
    clean.push(result.value);
  }
  return { ok: true, value: clean };
}

/** The contributions a descriptor declares. Placement has no second spelling. */
export function contributionsOf(plugin: { ui?: WebPluginUiContribution[] }): WebPluginUiContribution[] {
  return plugin.ui ?? [];
}

/** Highest priority wins; ties break on `pluginId/contributionId` for determinism. */
function compareOverrideCandidates(a: OwnedContribution, b: OwnedContribution): number {
  const priorityDelta = (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  return `${a.pluginId}/${a.contribution.id}`.localeCompare(`${b.pluginId}/${b.contribution.id}`);
}

function candidateKey(entry: OwnedContribution): string {
  return `${entry.pluginId}/${entry.contribution.id}`;
}

export interface OverrideResolution {
  replacement?: OwnedContribution;
  wrappers: OwnedContribution[];
  hidden: boolean;
}

export function resolveOverrides(
  target: WebUiComponent,
  entries: readonly OwnedContribution[],
  disabled: ReadonlySet<string> = new Set(),
  userChoice?: string,
): OverrideResolution {
  const candidates = entries
    .filter((entry) => entry.contribution.override?.target === target && !disabled.has(candidateKey(entry)))
    .sort(compareOverrideCandidates);
  const replaces = (entry: OwnedContribution): boolean => entry.contribution.override?.mode !== "wrap";
  const chosen = candidates.find((entry) => candidateKey(entry) === userChoice && replaces(entry));
  const replacement = chosen ?? candidates.find(replaces);
  return {
    ...(replacement !== undefined ? { replacement } : {}),
    wrappers: candidates.filter((entry) => entry.contribution.override?.mode === "wrap"),
    hidden: replacement?.contribution.override?.mode === "hide",
  };
}
