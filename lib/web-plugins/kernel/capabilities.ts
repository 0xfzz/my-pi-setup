/**
 * Capability grammar (PRD §7.2): `kind` or `kind:argument`, where the argument
 * may contain `*` globs. A plugin declares what it needs in its manifest; the
 * operator grants it; every registry, bridge, route and storage call asks
 * `assertGranted` before doing anything.
 */

export type CapabilityArgument = "none" | "optional" | "required";

/** Every capability kind the kernel knows about. Unknown kinds fail validation. */
export const CAPABILITY_KINDS = {
  "ui.slots": { argument: "optional" },
  "ui.replace": { argument: "required" },
  "ui.theme": { argument: "none" },
  "ui.css": { argument: "none" },
  "ui.route": { argument: "optional" },
  commands: { argument: "none" },
  keys: { argument: "none" },
  "hooks.observe": { argument: "required" },
  "hooks.transform": { argument: "required" },
  "hooks.veto": { argument: "required" },
  "services.provide": { argument: "required" },
  "services.replace": { argument: "required" },
  routes: { argument: "none" },
  storage: { argument: "optional" },
  jobs: { argument: "none" },
  "tap.pi-events": { argument: "optional" },
  "session.read": { argument: "none" },
  "session.write": { argument: "none" },
  "fs.read": { argument: "required" },
  net: { argument: "required" },
  exec: { argument: "none" },
} as const satisfies Record<string, { argument: CapabilityArgument }>;

export type CapabilityKind = keyof typeof CAPABILITY_KINDS;

export interface Capability {
  kind: CapabilityKind;
  arg?: string;
}

export type CapabilityResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Capabilities that can never be granted by the kernel; each use needs a per-run confirmation. */
export const NEVER_AUTO_GRANTABLE: ReadonlySet<CapabilityKind> = new Set(["exec"]);

/** Capabilities a `trusted` plugin cannot receive without an explicit operator grant. */
export const TRUSTED_ONLY: ReadonlySet<CapabilityKind> = new Set(["ui.css"]);

const ARG_RE = /^[A-Za-z0-9._:/*-]{1,128}$/;

function isKind(value: string): value is CapabilityKind {
  return Object.hasOwn(CAPABILITY_KINDS, value);
}

export function parseCapability(input: unknown): CapabilityResult<Capability> {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "capability must be a non-empty string" };
  }
  const colon = input.indexOf(":");
  const name = colon === -1 ? input : input.slice(0, colon);
  const arg = colon === -1 ? undefined : input.slice(colon + 1);
  if (!isKind(name)) {
    return { ok: false, error: `unknown capability "${name}"` };
  }
  const rule = CAPABILITY_KINDS[name].argument;
  if (rule === "none" && arg !== undefined) {
    return { ok: false, error: `capability "${name}" takes no argument` };
  }
  if (rule === "required" && (arg === undefined || arg.length === 0)) {
    return { ok: false, error: `capability "${name}" requires an argument` };
  }
  if (arg !== undefined && (!ARG_RE.test(arg) || arg.includes(".."))) {
    return { ok: false, error: `capability "${input}" has an invalid argument` };
  }
  return { ok: true, value: arg === undefined ? { kind: name } : { kind: name, arg } };
}

export function formatCapability(cap: Capability): string {
  return cap.arg === undefined ? cap.kind : `${cap.kind}:${cap.arg}`;
}

/** Parse a manifest capability list. Duplicates collapse; order is preserved. */
export function validateCapabilities(input: unknown): CapabilityResult<Capability[]> {
  if (!Array.isArray(input)) {
    return { ok: false, error: "capabilities must be an array" };
  }
  const seen = new Set<string>();
  const out: Capability[] = [];
  for (const entry of input) {
    const parsed = parseCapability(entry);
    if (!parsed.ok) return parsed;
    const key = formatCapability(parsed.value);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(parsed.value);
    }
  }
  return { ok: true, value: out };
}

export function hasWildcard(cap: Capability): boolean {
  return cap.arg !== undefined && cap.arg.includes("*");
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Whether one granted capability covers one requested capability.
 * A grant without an argument covers the kind with or without an argument; a
 * grant with an argument covers only requests whose argument matches its glob.
 */
export function grantCovers(grant: Capability, requested: Capability): boolean {
  if (grant.kind !== requested.kind) return false;
  if (grant.arg === undefined) return true;
  if (requested.arg === undefined) return grant.arg === "*";
  return globToRegExp(grant.arg).test(requested.arg);
}

export function isGranted(granted: readonly Capability[], requested: Capability): boolean {
  return granted.some((grant) => grantCovers(grant, requested));
}

/** Thrown when a plugin reaches for something it was not granted. */
export class CapabilityError extends Error {
  readonly plugin: string;
  readonly capability: string;

  constructor(plugin: string, capability: string) {
    super(`Plugin "${plugin}" lacks capability "${capability}"`);
    this.name = "CapabilityError";
    this.plugin = plugin;
    this.capability = capability;
  }
}

/** Throws `CapabilityError` naming the plugin and capability unless granted. */
export function assertGranted(plugin: string, granted: readonly Capability[], requested: Capability): void {
  if (!isGranted(granted, requested)) {
    throw new CapabilityError(plugin, formatCapability(requested));
  }
}

/**
 * Default grants for an enabled plugin: everything requested except capabilities
 * that are never auto-granted. Those stay pending until the operator confirms.
 */
export function autoGrant(requested: readonly Capability[]): { granted: Capability[]; pending: Capability[] } {
  const granted: Capability[] = [];
  const pending: Capability[] = [];
  for (const cap of requested) {
    (NEVER_AUTO_GRANTABLE.has(cap.kind) ? pending : granted).push(cap);
  }
  return { granted, pending };
}
