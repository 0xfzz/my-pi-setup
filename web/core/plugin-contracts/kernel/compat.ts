/**
 * `core.compat` (PRD §5.7): turns today's `WEB_PLUGINS` descriptors into
 * declarative candidates for the manager, so they run through the same lifecycle
 * (enable, disable, quarantine, persisted state) without any change to the
 * descriptors themselves. A descriptor carries no code, so its candidate has no
 * entry points and its runtime is empty.
 */
import { validateManifest, type PluginManifest } from "./manifest.ts";
import type { DiscoveredPlugin } from "./discovery.ts";
import { satisfies } from "./semver.ts";

/**
 * The versions this host serves. A manifest's `engines` range is checked
 * against these, so a plugin written for a different contract is refused by
 * name instead of failing at its first import.
 */
export const HOST_PI_WEB_VERSION = "1.0.0";
export const HOST_SDK_VERSION = "1.0.0";

/** The subset of a `WebPluginDescriptor` the compat layer reads. */
export interface DescriptorLike {
  id: string;
  title: string;
  description?: string;
}

export const COMPAT_VERSION = HOST_PI_WEB_VERSION;

/** Why this manifest cannot run on this host, or undefined when it can. */
export function engineMismatch(manifest: PluginManifest): string | undefined {
  if (!satisfies(HOST_PI_WEB_VERSION, manifest.engines.piWeb)) {
    return `requires piWeb ${manifest.engines.piWeb}; this host serves ${HOST_PI_WEB_VERSION}`;
  }
  if (!satisfies(HOST_SDK_VERSION, manifest.engines.sdk)) {
    return `requires sdk ${manifest.engines.sdk}; this host serves ${HOST_SDK_VERSION}`;
  }
  return undefined;
}

/**
 * Build a manifest for a descriptor. Descriptor ids are already dotless
 * (`todo`, `subagent-graph`), which the manifest grammar accepts, so no id is rewritten.
 */
export function manifestForDescriptor(descriptor: DescriptorLike): PluginManifest {
  const result = validateManifest({
    id: descriptor.id,
    name: descriptor.title,
    version: COMPAT_VERSION,
    engines: { piWeb: `^${COMPAT_VERSION}`, sdk: `^${COMPAT_VERSION}` },
    trust: "declarative",
  });
  if (!result.ok) {
    throw new Error(`descriptor "${descriptor.id}" cannot be adapted: ${result.error}`);
  }
  return result.manifest;
}

/** A repo-source candidate for each descriptor; `dir` is the directory the descriptors live in. */
export function compatCandidates(descriptors: readonly DescriptorLike[], dir: string): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) continue;
    seen.add(descriptor.id);
    out.push({ id: descriptor.id, source: "repo", dir, manifest: manifestForDescriptor(descriptor), inline: true });
  }
  return out;
}
