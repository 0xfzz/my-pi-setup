// Route tables: which provider/model each virtual route resolves to, and in
// what order. This is provider-agnostic: a route can point at any registered
// provider and model, and every route carries an ordered fallback chain.

import { existsSync, readFileSync } from "node:fs";

export type RouteTarget = {
  /** Canonical `provider/modelId`. */
  model: string;
  /** Optional account pool name; omitted means the provider's normal auth. */
  pool?: string;
  /** Thinking level to request, when the physical model supports it. */
  thinking?: string;
};

export type RouteConfig = {
  /** Route key: becomes the virtual model id under the router provider. */
  name: string;
  /** Display name in /model. */
  label?: string;
  description?: string;
  /** Ordered candidates; the first usable one wins. */
  targets: RouteTarget[];
  /** Routing policy for continuation and retry requests. */
  sticky?: boolean;
  /** Account pools this route may draw from, when targets omit `pool`. */
  pool?: string;
};

export type RouteTable = {
  /** Provider id that hosts the virtual models. */
  provider: string;
  routes: RouteConfig[];
};

export type ParsedModelRef = { provider: string; modelId: string };

const ROUTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse `provider/modelId`. Model ids may contain slashes. */
export function parseModelRef(value: string): ParsedModelRef | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash).trim();
  const modelId = value.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

function normalizeTarget(raw: unknown, where: string): RouteTarget | string {
  if (typeof raw === "string") {
    const parsed = parseModelRef(raw);
    return parsed ? { model: `${parsed.provider}/${parsed.modelId}` } : `${where}: expected "provider/model"`;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${where}: expected a string or object`;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.model !== "string") return `${where}: "model" is required`;
  const parsed = parseModelRef(entry.model);
  if (!parsed) return `${where}: "model" must be "provider/model" (got "${entry.model}")`;
  if (entry.pool !== undefined && typeof entry.pool !== "string") return `${where}: "pool" must be a string`;
  if (entry.thinking !== undefined && typeof entry.thinking !== "string") return `${where}: "thinking" must be a string`;
  return {
    model: `${parsed.provider}/${parsed.modelId}`,
    ...(typeof entry.pool === "string" && entry.pool.trim() ? { pool: entry.pool.trim() } : {}),
    ...(typeof entry.thinking === "string" && entry.thinking.trim() ? { thinking: entry.thinking.trim() } : {}),
  };
}

function normalizeRoute(raw: unknown, where: string): RouteConfig | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${where}: expected an object`;
  const entry = raw as Record<string, unknown>;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return `${where}: "name" is required`;
  if (!ROUTE_NAME.test(name)) return `${where}: "name" may only contain letters, digits, dot, dash and underscore`;
  const targetsRaw = Array.isArray(entry.targets) ? entry.targets : entry.target !== undefined ? [entry.target] : [];
  if (!targetsRaw.length) return `route "${name}": at least one target is required`;
  const targets: RouteTarget[] = [];
  for (const [index, target] of targetsRaw.entries()) {
    const normalized = normalizeTarget(target, `route "${name}" target ${index}`);
    if (typeof normalized === "string") return normalized;
    targets.push(normalized);
  }
  if (entry.sticky !== undefined && typeof entry.sticky !== "boolean") return `route "${name}": "sticky" must be a boolean`;
  if (entry.pool !== undefined && typeof entry.pool !== "string") return `route "${name}": "pool" must be a string`;
  return {
    name,
    targets,
    ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
    ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}),
    ...(entry.sticky !== undefined ? { sticky: entry.sticky as boolean } : {}),
    ...(typeof entry.pool === "string" && entry.pool.trim() ? { pool: entry.pool.trim() } : {}),
  };
}

export function parseRouteTable(raw: unknown, defaultProvider = "router"): { table: RouteTable; errors: string[] } {
  const errors: string[] = [];
  const table: RouteTable = { provider: defaultProvider, routes: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { table, errors: ['expected a JSON object with a "routes" array'] };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.provider !== undefined) {
    if (typeof doc.provider !== "string" || !doc.provider.trim()) errors.push('"provider" must be a non-empty string');
    else table.provider = doc.provider.trim();
  }
  const routesRaw = doc.routes;
  if (!Array.isArray(routesRaw)) return { table, errors: [...errors, '"routes" must be an array'] };
  const seen = new Set<string>();
  for (const [index, entry] of routesRaw.entries()) {
    const route = normalizeRoute(entry, `routes[${index}]`);
    if (typeof route === "string") { errors.push(route); continue; }
    if (seen.has(route.name)) { errors.push(`route "${route.name}": duplicate name`); continue; }
    seen.add(route.name);
    table.routes.push(route);
  }
  return { table, errors };
}

export function readRouteTable(path: string, defaultProvider = "router"): { table: RouteTable; errors: string[] } {
  if (!existsSync(path)) return { table: { provider: defaultProvider, routes: [] }, errors: [] };
  try {
    return parseRouteTable(JSON.parse(readFileSync(path, "utf8")), defaultProvider);
  } catch (error) {
    return { table: { provider: defaultProvider, routes: [] }, errors: [`${path}: ${(error as Error).message}`] };
  }
}

/** Merge route tables; later routes with the same name replace earlier ones. */
export function mergeRouteTables(...tables: RouteTable[]): RouteTable {
  const provider = tables.find((table) => table.routes.length)?.provider ?? tables[0]?.provider ?? "router";
  const byName = new Map<string, RouteConfig>();
  for (const table of tables) for (const route of table.routes) byName.set(route.name, route);
  return { provider, routes: [...byName.values()] };
}

export function findRoute(table: RouteTable, name: string): RouteConfig | undefined {
  return table.routes.find((route) => route.name === name);
}

/** Ordered candidate targets for a route. */
export function routeTargets(route: RouteConfig): RouteTarget[] {
  return route.targets;
}

/** Pool name for a target: the target's own pool, else the route's pool. */
export function targetPool(route: RouteConfig, target: RouteTarget): string | undefined {
  return target.pool ?? route.pool;
}

/**
 * Move the failed target to the end and return the remaining chain, so a retry
 * tries the next candidate before repeating a model that just failed.
 *
 * `failed` may be a model reference or a predicate. A predicate is needed when
 * the reported model does not use the target's own provider id, as with pools.
 */
export function advanceChain(
  route: RouteConfig,
  failed: string | ((target: RouteTarget) => boolean),
): RouteTarget[] {
  const matches = typeof failed === "function" ? failed : (target: RouteTarget) => target.model === failed;
  const index = route.targets.findIndex(matches);
  if (index < 0) return route.targets.slice(1);
  return [...route.targets.slice(index + 1), ...route.targets.slice(0, index)];
}
