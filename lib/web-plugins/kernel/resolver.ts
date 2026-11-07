/**
 * Dependency resolution (PRD §6.6, AC1). Given validated candidates, decide which
 * can run, in what order (dependencies first), and why the rest cannot. The
 * output is deterministic: ties break on plugin id, so the inspector can show
 * the same order every time.
 */
import { satisfies } from "./semver.ts";

export interface ResolverInput {
  id: string;
  version: string;
  dependsOn: Readonly<Record<string, string>>;
  optionalDependsOn: Readonly<Record<string, string>>;
}

export interface Resolution {
  /** Resolvable plugins, dependencies before dependents. */
  ordered: string[];
  /** Plugins that cannot run, with a reason that names the pair or the cycle. */
  unresolved: Record<string, string>;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Returns a cycle through `start` as `a -> b -> a`, or undefined if `start` is on none. */
function findCycle(start: string, edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const path: string[] = [start];
  const onPath = new Set<string>([start]);
  const visit = (node: string): string[] | undefined => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) return [...path, start];
      if (onPath.has(next)) continue;
      path.push(next);
      onPath.add(next);
      const found = visit(next);
      if (found) return found;
      path.pop();
      onPath.delete(next);
    }
    return undefined;
  };
  return visit(start);
}

export function resolvePlugins(candidates: readonly ResolverInput[]): Resolution {
  const byId = new Map<string, ResolverInput>();
  const unresolved: Record<string, string> = {};
  for (const candidate of candidates) {
    if (byId.has(candidate.id)) {
      unresolved[candidate.id] = `duplicate plugin id "${candidate.id}"`;
      continue;
    }
    byId.set(candidate.id, candidate);
  }

  // Pass 1: missing or incompatible direct dependencies are unresolved.
  for (const [id, candidate] of byId) {
    for (const [dep, range] of Object.entries(candidate.dependsOn)) {
      const target = byId.get(dep);
      if (!target) {
        unresolved[id] = `missing dependency "${dep}" (requires ${range})`;
        break;
      }
      if (!satisfies(target.version, range)) {
        unresolved[id] = `"${id}" requires "${dep}" ${range}, found ${target.version}`;
        break;
      }
    }
    if (unresolved[id]) continue;
    for (const [dep, range] of Object.entries(candidate.optionalDependsOn)) {
      const target = byId.get(dep);
      if (target && !satisfies(target.version, range)) {
        unresolved[id] = `"${id}" optionally requires "${dep}" ${range}, found ${target.version}`;
        break;
      }
    }
  }

  // Pass 2: a plugin whose required dependency is unresolved cannot run either.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, candidate] of byId) {
      if (unresolved[id]) continue;
      const blocked = Object.keys(candidate.dependsOn).find((dep) => unresolved[dep]);
      if (blocked) {
        unresolved[id] = `depends on unresolved plugin "${blocked}"`;
        changed = true;
      }
    }
  }

  // Edges run from dependent to dependency among the still-candidate plugins.
  const live = sortedIds([...byId.keys()].filter((id) => !unresolved[id]));
  const edges = new Map<string, string[]>();
  for (const id of live) {
    const candidate = byId.get(id)!;
    const deps = [...Object.keys(candidate.dependsOn), ...Object.keys(candidate.optionalDependsOn)]
      .filter((dep) => !unresolved[dep] && byId.has(dep));
    edges.set(id, sortedIds(new Set(deps)));
  }

  // Kahn's algorithm: repeatedly take the smallest plugin whose dependencies are placed.
  const ordered: string[] = [];
  const placed = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const id of live) {
      if (placed.has(id)) continue;
      if ((edges.get(id) ?? []).every((dep) => placed.has(dep))) {
        ordered.push(id);
        placed.add(id);
        progress = true;
      }
    }
  }

  // Whatever is left is on a cycle or depends on one. Name the cycle for each member.
  for (const id of live) {
    if (placed.has(id)) continue;
    const cycle = findCycle(id, edges);
    unresolved[id] = cycle
      ? `dependency cycle: ${cycle.join(" -> ")}`
      : `depends on a dependency cycle`;
  }

  return { ordered, unresolved };
}

/** Reverse of the activation order: dependents deactivate before their dependencies. */
export function deactivationOrder(ordered: readonly string[]): string[] {
  return [...ordered].reverse();
}

/** Ids of plugins that declare a required dependency on `id`, directly. */
export function requiredDependents(id: string, candidates: readonly ResolverInput[]): string[] {
  return sortedIds(candidates.filter((c) => Object.hasOwn(c.dependsOn, id)).map((c) => c.id));
}
