/**
 * `pi-web-plugin.json` (PRD §5.3): the one file the kernel reads before it runs
 * any plugin code. Validation is total: every field is either accepted in its
 * declared shape or the whole manifest is rejected with a named error.
 */
import { TRUSTED_ONLY, validateCapabilities, type Capability } from "./capabilities.ts";
import { isAllowedBrowserEntry } from "../../protocol/manifest-extension.ts";
import { isValidRange } from "./semver.ts";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/**
 * How far a plugin is trusted. `declarative` ships no code at all; `trusted`
 * may run a server half in the host process. There is no third tier: a
 * sandbox would be a different runtime, and a manifest must not be able to
 * claim a guarantee the host does not provide.
 */
export const TRUST_TIERS = ["declarative", "trusted"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * When a plugin's code is loaded. Only `onStartup` is implemented: the manager
 * activates every enabled plugin at boot. The other events the PRD sketches
 * (onRoute, onSlotVisible, onCommand, …) would each need a lazy-activation
 * seam in the host, and a manifest that declares one would be lying about what
 * the kernel does — so they are refused rather than accepted and ignored.
 */
export const ACTIVATION_EVENTS = ["onStartup"] as const;
export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  engines: { piWeb: string; sdk: string };
  main: { server?: string; browser?: string };
  trust: TrustTier;
  capabilities: Capability[];
  dependsOn: Record<string, string>;
  optionalDependsOn: Record<string, string>;
  activation: ActivationEvent[];
  settings?: Record<string, unknown>;
  contributes?: Record<string, unknown>;
}

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

const TOP_LEVEL = [
  "$schema", "id", "name", "version", "engines", "main", "trust", "capabilities",
  "dependsOn", "optionalDependsOn", "activation", "settings", "contributes",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Entry paths stay inside the plugin directory: relative, `./`-prefixed, no `..`. */
function entryPath(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("./") && !value.split("/").includes("..") && value.length <= 256;
}

function rangeMap(value: unknown, field: string): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object of id -> semver range` };
  const out: Record<string, string> = {};
  for (const [id, range] of Object.entries(value)) {
    if (!PLUGIN_ID_PATTERN.test(id)) return { ok: false, error: `${field} references invalid plugin id "${id}"` };
    if (typeof range !== "string" || !isValidRange(range)) return { ok: false, error: `${field}["${id}"] is not a valid semver range` };
    out[id] = range;
  }
  return { ok: true, value: out };
}

/** Trust is validated again later; this only gates entry-point parsing. */
function trustInput(value: unknown): "declarative" | "trusted" {
  return value === "trusted" ? "trusted" : "declarative";
}

export function validateManifest(input: unknown): ManifestResult {
  if (!isRecord(input)) return { ok: false, error: "manifest must be a JSON object" };
  const name = typeof input.id === "string" ? input.id : "unknown";
  const fail = (reason: string): ManifestResult => ({ ok: false, error: `Plugin "${name}": ${reason}` });

  const unknown = Object.keys(input).filter((key) => !TOP_LEVEL.includes(key));
  if (unknown.length > 0) return fail(`unknown manifest field(s): ${unknown.join(", ")}`);

  if (typeof input.id !== "string" || !PLUGIN_ID_PATTERN.test(input.id) || input.id.length > 100) {
    return fail("id must match ^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 120) {
    return fail("name is missing, empty, or longer than 120 characters");
  }
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(input.version)) {
    return fail("version must be a strict semver string");
  }

  if (!isRecord(input.engines) || typeof input.engines.piWeb !== "string" || typeof input.engines.sdk !== "string") {
    return fail("engines must declare piWeb and sdk semver ranges");
  }
  if (!isValidRange(input.engines.piWeb)) return fail(`engines.piWeb "${input.engines.piWeb}" is not a valid range`);
  if (!isValidRange(input.engines.sdk)) return fail(`engines.sdk "${input.engines.sdk}" is not a valid range`);

  const main: PluginManifest["main"] = {};
  if (input.main !== undefined) {
    if (!isRecord(input.main)) return fail("main must be an object with a server entry");
    for (const key of Object.keys(input.main)) {
      if (key !== "server" && key !== "browser") return fail(`main.${key} is not a known entry point`);
    }
    if (input.main.server !== undefined) {
      if (!entryPath(input.main.server)) return fail("main.server must be a ./relative path inside the plugin");
      main.server = input.main.server as string;
    }
    if (input.main.browser !== undefined) {
      if (!isAllowedBrowserEntry(trustInput(input.trust), input.main.browser)) {
        return fail("main.browser requires trust 'trusted' and a ./relative path inside the plugin");
      }
      main.browser = input.main.browser as string;
    }
  }

  const trust = input.trust === undefined ? "declarative" : input.trust;
  if (typeof trust !== "string" || !(TRUST_TIERS as readonly string[]).includes(trust)) {
    return fail(`trust must be one of ${TRUST_TIERS.join(", ")}`);
  }
  if (trust === "declarative" && (main.server !== undefined || main.browser !== undefined)) {
    return fail("a declarative plugin cannot declare a code entry point");
  }
  if (main.browser !== undefined && trust !== "trusted") {
    return fail("main.browser requires trust 'trusted'");
  }

  const caps = validateCapabilities(input.capabilities ?? []);
  if (!caps.ok) return fail(caps.error);
  const trustedOnly = caps.value.find((cap) => TRUSTED_ONLY.has(cap.kind));
  if (trustedOnly && trust !== "trusted") {
    return fail(`capability "${trustedOnly.kind}" requires trust "trusted"`);
  }

  const deps = rangeMap(input.dependsOn, "dependsOn");
  if (!deps.ok) return fail(deps.error);
  const optional = rangeMap(input.optionalDependsOn, "optionalDependsOn");
  if (!optional.ok) return fail(optional.error);
  if (Object.hasOwn(deps.value, input.id) || Object.hasOwn(optional.value, input.id)) {
    return fail("a plugin cannot depend on itself");
  }

  const activation = input.activation ?? [...ACTIVATION_EVENTS];
  if (!Array.isArray(activation) || activation.length === 0) {
    return fail("activation must be a non-empty array of events");
  }
  for (const event of activation) {
    if (!(ACTIVATION_EVENTS as readonly unknown[]).includes(event)) {
      return fail(`unsupported activation event "${String(event)}"; this host activates on ${ACTIVATION_EVENTS.join(", ")}`);
    }
  }

  if (input.settings !== undefined && !isRecord(input.settings)) return fail("settings must be a JSON schema object");
  if (input.contributes !== undefined && !isRecord(input.contributes)) return fail("contributes must be an object");

  const manifest: PluginManifest = {
    id: input.id,
    name: input.name,
    version: input.version,
    engines: { piWeb: input.engines.piWeb, sdk: input.engines.sdk },
    main,
    trust: trust as TrustTier,
    capabilities: caps.value,
    dependsOn: deps.value,
    optionalDependsOn: optional.value,
    activation: [...(activation as ActivationEvent[])],
    ...(input.settings !== undefined ? { settings: structuredClone(input.settings) as Record<string, unknown> } : {}),
    ...(input.contributes !== undefined ? { contributes: structuredClone(input.contributes) as Record<string, unknown> } : {}),
  };
  return { ok: true, manifest };
}

/** Pure parse of manifest text; a JSON syntax error is a rejection, never a throw. */
export function parseManifestText(text: string): ManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return validateManifest(parsed);
}
