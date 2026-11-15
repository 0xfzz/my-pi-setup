// Broadcasting plugin-registry changes to connected browsers.
//
// `/api/plugins` is fetched once per page load, so an open tab holds the plugin
// set it was opened with. Everything that changes what is served — an operator
// enabling, disabling or reloading a plugin, the breaker quarantining one, safe
// mode parking them — moves the kernel's lifecycle, and every move is appended
// to the audit log. Watching that one stream is what keeps every open tab on
// the same registry as the server, without polling and without a second list of
// events to keep in sync.

import type { AuditLog, AuditEntry } from "../plugin-contracts/kernel/audit.ts";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";

/** The kernel state a broadcast needs. */
export interface ObservableRegistry {
  readonly audit: AuditLog;
  visible(): readonly WebPluginDescriptor[];
}

/**
 * Audit kinds that can change what `/api/plugins` serves. Grants, vetoes and
 * denials are lifecycle-neutral: they change what a plugin may do, not whether
 * it is listed.
 */
const VISIBILITY_KINDS = new Set<AuditEntry["kind"]>([
  "enabled",
  "disabled",
  "lifecycle",
  "quarantined",
  "quarantine-cleared",
  "safe-mode",
  "rejected",
  "discovered",
]);

/**
 * Call `announce` whenever the served registry differs from what was last
 * announced. Returns the unsubscribe function.
 *
 * The registry is compared, not the audit entry: a lifecycle move that leaves
 * the visible set unchanged (a reload that lands the same descriptors) is not
 * worth a refetch.
 */
export function watchPluginRegistry(registry: ObservableRegistry, announce: () => void): () => void {
  let lastServed = JSON.stringify(registry.visible());
  return registry.audit.subscribe((entry) => {
    if (!VISIBILITY_KINDS.has(entry.kind)) return;
    const served = JSON.stringify(registry.visible());
    if (served === lastServed) return;
    lastServed = served;
    announce();
  });
}
