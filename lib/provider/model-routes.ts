// Route tables: which provider/model each virtual route resolves to, and in
// what order. This is provider-agnostic: a route can point at any registered
// provider and model, and every route carries an ordered fallback chain.
//
// Two knobs say how that chain is used, and they answer different questions:
//
//   method — *how* the candidates are ordered (declaration order, rotation,
//            price, or the model that answered last).
//   when   — *whether* that ordering is recomputed for a request, or the model
//            that already answered is kept and only a retry moves on.
//
// Both default to the behaviour that existed before they were added
// (`priority` + `turn`), so an older config routes exactly as it did.

import { existsSync, readFileSync } from "node:fs";

/**
 * How a route's candidates are ordered before a request picks one.
 *
 * - `priority`: declaration order. The first usable target wins.
 * - `round-robin`: rotate per user turn, carrying a cursor across turns.
 * - `cheapest`: ascending catalog price, unknown price last.
 * - `last-good`: the model that answered the previous turn first (LKGP).
 */
export type RouteMethod = "priority" | "round-robin" | "cheapest" | "last-good";

/**
 * When the chain is re-decided instead of kept on the answering model.
 *
 * - `turn`: re-decide on every user request; continuations stay put.
 * - `failure`: keep the answering model across user turns; only a retry moves on.
 * - `quota`: like `failure`, but a retry only moves on for a quota/rate-limit
 *   failure — anything else retries the same target.
 * - `overflow`: like `failure`, but a retry only moves on for a context overflow.
 */
export type RouteWhen = "turn" | "failure" | "quota" | "overflow";

/** Failure classes a trigger can distinguish. */
export type RouteFailureClass = "quota" | "overflow" | "other";

/**
 * Which model a request starts at.
 *
 * - `order`: order the chain with the route's method.
 * - `previous`: keep the model that answered the latest successful response.
 * - `failed`: retry the target that just failed, without moving on.
 */
export type RouteHead = "order" | "previous" | "failed";

export type RouteDecision = {
  /** Where the candidate chain starts. */
  head: RouteHead;
  /** Move the failed target to the end before choosing. */
  advance: boolean;
};

/** Catalog facts the ordering needs; keeps this module free of Pi imports. */
export type TargetFacts = {
  /** Price per token, as the model catalog reports it. */
  cost?: { input: number; output: number };
};

export const ROUTE_METHODS: readonly RouteMethod[] = ["priority", "round-robin", "cheapest", "last-good"];
export const ROUTE_WHENS: readonly RouteWhen[] = ["turn", "failure", "quota", "overflow"];

/** One vocabulary for the command, the status report and the TUI. */
export const METHOD_LABELS: Record<RouteMethod, string> = {
  "priority": "priority",
  "round-robin": "round-robin",
  "cheapest": "cheapest",
  "last-good": "last-good",
};

export const WHEN_LABELS: Record<RouteWhen, string> = {
  turn: "every turn",
  failure: "on failure",
  quota: "on quota",
  overflow: "on overflow",
};

export const METHOD_HINTS: Record<RouteMethod, string> = {
  "priority": "declaration order; the first usable target wins",
  "round-robin": "rotate the head on each user turn",
  "cheapest": "ascending catalog price; unknown price last",
  "last-good": "the model that answered last time goes first",
};

export const WHEN_HINTS: Record<RouteWhen, string> = {
  turn: "re-decide on every user request",
  failure: "keep the answering model; a retry moves on",
  quota: "keep it; only a retry after quota/429 moves on",
  overflow: "keep it; only a retry after a context overflow moves on",
};

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
  /** How candidates are ordered. Defaults to `priority` (declaration order). */
  method?: RouteMethod;
  /** When the chain is re-decided. Defaults to `turn` (every user request). */
  when?: RouteWhen;
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
  const method = enumField(entry.method, ROUTE_METHODS, `route "${name}": unknown method`, ROUTE_METHODS);
  if (typeof method !== "object") return method;
  const when = enumField(entry.when, ROUTE_WHENS, `route "${name}": unknown when`, ROUTE_WHENS);
  if (typeof when !== "object") return when;
  return {
    name,
    targets,
    ...(typeof entry.label === "string" && entry.label.trim() ? { label: entry.label.trim() } : {}),
    ...(typeof entry.description === "string" && entry.description.trim() ? { description: entry.description.trim() } : {}),
    ...(entry.sticky !== undefined ? { sticky: entry.sticky as boolean } : {}),
    ...(typeof entry.pool === "string" && entry.pool.trim() ? { pool: entry.pool.trim() } : {}),
    ...(method.value ? { method: method.value as RouteMethod } : {}),
    ...(when.value ? { when: when.value as RouteWhen } : {}),
  };
}

/**
 * Validate one enumerated field.
 *
 * An absent field keeps its default (`value: undefined`), so an older config is
 * never rewritten just because it was loaded. An unknown value is an error, not
 * a silent default: silently routing a `cheapest` route in declaration order
 * would look like the setting was ignored.
 */
function enumField(
  raw: unknown,
  allowed: readonly string[],
  prefix: string,
  choices: readonly string[],
): { value?: string } | string {
  if (raw === undefined) return {};
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!allowed.includes(value)) {
    return `${prefix} "${typeof raw === "string" ? value : String(raw)}" (use ${choices.join(", ")})`;
  }
  return { value };
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

/** Effective ordering method; an older config has none and keeps declaration order. */
export function routeMethod(route: RouteConfig): RouteMethod {
  return route.method ?? "priority";
}

/** Effective trigger; an older config has none and re-decides every user turn. */
export function routeWhen(route: RouteConfig): RouteWhen {
  return route.when ?? "turn";
}

/** Compact `cheapest · on quota` label for status lines and the TUI. */
export function describeRoutePolicy(route: RouteConfig): string {
  return `${METHOD_LABELS[routeMethod(route)]} · ${WHEN_LABELS[routeWhen(route)]}`;
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
 * Order a route's candidates for one request.
 *
 * The chain is always the same set of targets; only the head changes. Callers
 * pass the facts the method needs, so this stays a pure function:
 *
 * - `priority` returns the declaration order untouched.
 * - `round-robin` rotates so the target *after* `cursor` comes first, wrapping.
 * - `cheapest` sorts by catalog price, keeping declaration order for ties and
 *   placing targets whose price is unknown last.
 * - `last-good` promotes the target that answered the last successful response.
 */
export function orderTargets(
  route: RouteConfig,
  facts: (target: RouteTarget) => TargetFacts | undefined,
  context: { cursor?: string; previous?: string } = {},
): RouteTarget[] {
  const base = route.targets;
  if (base.length < 2) return base;
  switch (routeMethod(route)) {
    case "round-robin": {
      const index = context.cursor === undefined ? -1 : base.findIndex((target) => target.model === context.cursor);
      if (index < 0) return base;
      return [...base.slice(index + 1), ...base.slice(0, index + 1)];
    }
    case "cheapest": {
      const priced = base.map((target, index) => ({ target, index, price: targetPrice(facts(target)) }));
      priced.sort((a, b) => (a.price === b.price ? a.index - b.index : a.price - b.price));
      return priced.map((entry) => entry.target);
    }
    case "last-good": {
      const index = context.previous === undefined ? -1 : base.findIndex((target) => target.model === context.previous);
      if (index <= 0) return base;
      return [base[index]!, ...base.slice(0, index), ...base.slice(index + 1)];
    }
    case "priority":
    default:
      return base;
  }
}

/** Total price per token, or `Infinity` when the catalog does not know it. */
function targetPrice(facts: TargetFacts | undefined): number {
  const input = facts?.cost?.input;
  const output = facts?.cost?.output;
  const values = [input, output].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return Number.POSITIVE_INFINITY;
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Decide where a request starts and whether it moves past the failed target.
 *
 * `failedClass` is the caller's classification of the failure, so this stays
 * free of provider-specific error matching. A `quota` route retries the same
 * target after, say, an auth error, and only moves on when the model really ran
 * out of quota — which is the difference between this and `failure`.
 */
export function routeDecision(
  route: RouteConfig,
  request: { reason: "user" | "continuation" | "retry" | "direct"; failedClass?: RouteFailureClass },
): RouteDecision {
  const when = routeWhen(route);
  if (when === "turn") {
    // An autonomous request inside the agent loop must not lose the answering
    // model, and a retry must not re-rotate past the target it is advancing to.
    if (request.reason === "continuation") return { head: "previous", advance: false };
    return { head: "order", advance: request.reason === "retry" };
  }
  if (request.reason !== "retry") {
    // `failure`, `quota` and `overflow` all keep the answering model across
    // user turns; they differ only in what counts as a reason to move on.
    return when === "failure" && request.reason === "direct"
      ? { head: "order", advance: false }
      : { head: "previous", advance: false };
  }
  const wanted: RouteFailureClass = when === "quota" ? "quota" : when === "overflow" ? "overflow" : "other";
  const matches = when === "failure" || (request.failedClass ?? "other") === wanted;
  return matches ? { head: "order", advance: true } : { head: "failed", advance: false };
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
