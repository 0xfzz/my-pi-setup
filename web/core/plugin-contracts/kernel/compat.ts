/**
 * `core.compat` (PRD §5.7): turns today's `WEB_PLUGINS` descriptors into
 * declarative candidates for the manager, so they run through the same lifecycle
 * (enable, disable, quarantine, persisted state) without any change to the
 * descriptors themselves. A descriptor carries no code, so its candidate has no
 * entry points and its runtime is empty.
 */
import { validateManifest, type PluginManifest } from "./manifest.ts";
import type { DiscoveredPlugin } from "./discovery.ts";

/** The subset of a `WebPluginDescriptor` the compat layer reads. */
export interface DescriptorLike {
  id: string;
  title: string;
  description?: string;
}

export const COMPAT_VERSION = "1.0.0";

/**
 * Build a manifest for a descriptor. Descriptor ids are already dotless
 * (`todo`, `dashboard`), which the manifest grammar accepts, so no id is rewritten.
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
    out.push({ id: descriptor.id, source: "repo", dir, manifest: manifestForDescriptor(descriptor) });
  }
  return out;
}
