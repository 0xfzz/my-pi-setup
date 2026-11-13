/**
 * Service registry (PRD §5.5 rule 6, R12). A named implementation that other code
 * resolves at call time. A plugin may provide a default, replace it exclusively,
 * or decorate it. Resolution: the highest-priority replacement (or else the
 * highest-priority provider) is the base; decorators wrap it outermost-first by
 * priority. Two exclusive replacements with equal priority conflict: the later
 * one is refused with a named diagnostic.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import { isProtectedPoint } from "./catalog.ts";

export type ServiceMode = "provide" | "replace" | "decorate";

export interface ServiceOwner {
  pluginId: string;
  grants: readonly Capability[];
}

interface Entry {
  owner: ServiceOwner;
  mode: ServiceMode;
  priority: number;
  impl: (...args: never[]) => unknown;
  seq: number;
}

export interface ServiceConflict {
  service: string;
  pluginId: string;
  message: string;
}

export class ServiceRegistry {
  private readonly entries = new Map<string, Entry[]>();
  private readonly conflicts: ServiceConflict[] = [];
  private seq = 1;

  /**
   * Register an implementation. `impl` is the service itself for provide/replace, and a
   * wrapper `(next) => impl` for decorate. Returns the unregister function, or throws.
   */
  register(owner: ServiceOwner, name: string, mode: ServiceMode, impl: (...args: never[]) => unknown, priority = 0): () => void {
    const service = name.startsWith("service:") ? name : `service:${name}`;
    // The catalog lists protected points by their bare id, so check the name as given and prefixed.
    if (isProtectedPoint(name) || isProtectedPoint(service)) {
      throw new Error(`Plugin "${owner.pluginId}": "${name}" is protected and cannot be replaced`);
    }
    const cap = parseCapability(`services.${mode === "provide" ? "provide" : "replace"}:${service}`);
    if (!cap.ok) throw new Error(`Plugin "${owner.pluginId}": ${cap.error}`);
    const requested = mode === "decorate" ? parseCapability(`services.replace:${service}`) : cap;
    if (!requested.ok) throw new Error(`Plugin "${owner.pluginId}": ${requested.error}`);
    assertGranted(owner.pluginId, owner.grants, requested.value);

    const list = this.entries.get(service) ?? [];
    if (mode === "replace") {
      const clash = list.find((e) => e.mode === "replace" && e.priority === priority);
      if (clash) {
        const message = `exclusive replacement conflict on "${service}" at priority ${priority}: ${clash.owner.pluginId} already holds it`;
        this.conflicts.push({ service, pluginId: owner.pluginId, message });
        throw new Error(`Plugin "${owner.pluginId}": ${message}`);
      }
    }
    const entry: Entry = { owner, mode, priority, impl, seq: this.seq++ };
    this.entries.set(service, [...list, entry]);
    return () => {
      const current = this.entries.get(service) ?? [];
      this.entries.set(service, current.filter((e) => e !== entry));
    };
  }

  /** Remove every service entry a plugin made. */
  removeOwner(pluginId: string): number {
    let removed = 0;
    for (const [service, list] of this.entries) {
      const kept = list.filter((e) => e.owner.pluginId !== pluginId);
      removed += list.length - kept.length;
      this.entries.set(service, kept);
    }
    return removed;
  }

  conflictLog(): readonly ServiceConflict[] {
    return this.conflicts;
  }

  /** The composed implementation, or undefined when nothing provides the service. */
  resolve<T extends (...args: never[]) => unknown>(name: string): T | undefined {
    const service = name.startsWith("service:") ? name : `service:${name}`;
    const list = this.entries.get(service) ?? [];
    const byRank = (a: Entry, b: Entry) => b.priority - a.priority || a.seq - b.seq;
    const replacements = list.filter((e) => e.mode === "replace").sort(byRank);
    const providers = list.filter((e) => e.mode === "provide").sort(byRank);
    const decorators = list.filter((e) => e.mode === "decorate").sort(byRank);
    const base = replacements[0] ?? providers[0];
    if (!base) return undefined;
    // Decorators sorted highest first: the highest-priority decorator is applied last, so it is outermost.
    let fn = base.impl as (...args: unknown[]) => unknown;
    for (const decorator of [...decorators].reverse()) {
      fn = (decorator.impl as (next: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown)(fn);
    }
    return fn as unknown as T;
  }
}
