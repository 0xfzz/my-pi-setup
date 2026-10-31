// Writing the route half of `account-router.json` without clobbering the rest.
//
// The router config file is a shared document: the same object holds `routes`,
// `pools` and whatever else the user keeps there. A writer that serialised a
// parsed table back over it would silently delete the pools — and with them the
// user's accounts — so every write here is a read-modify-write on the *raw*
// document, touching only the one route it was asked to change. Untouched
// routes keep their original JSON, including keys this code does not know.
//
// Two rules keep a bug from becoming data loss:
//   - a file that is not a JSON object is refused, not replaced;
//   - a route is validated by re-parsing it before it reaches the file.
//
// Writes are atomic (temp + rename). A new file is created owner-only because a
// pool can hold a literal `apiKey`; an existing file keeps the permissions it
// already had, so the writer never quietly tightens or loosens them.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseRouteTable, type RouteConfig, type RouteTarget } from "./model-routes.ts";

/** File name of the router config, in the agent dir and in `.pi/`. */
export const ROUTE_FILE = "account-router.json";

/** The two files a route can live in; the project one wins per route name. */
export type RouteSource = "global" | "project";

export type SourcedRoute = {
  route: RouteConfig;
  /** File that declared the effective copy of this route. */
  source: RouteSource;
};

export type RouteDoc = {
  path: string;
  source: RouteSource;
  /** Raw parsed document, so a write can preserve keys this code never reads. */
  raw: Record<string, unknown>;
  routes: SourcedRoute[];
  errors: string[];
};

/** Config paths for one session, so callers never rebuild them inconsistently. */
export function routerConfigPaths(agentDir: string, cwd: string): { global: string; project: string } {
  return { global: join(agentDir, ROUTE_FILE), project: join(cwd, ".pi", ROUTE_FILE) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one config file, keeping the raw document.
 *
 * A missing file is an empty document, not an error. A broken one is reported
 * and treated as empty for *reading*; `saveRoute` refuses to write to it.
 */
export function readRouteDoc(path: string, source: RouteSource): RouteDoc {
  const empty: RouteDoc = { path, source, raw: {}, routes: [], errors: [] };
  if (!existsSync(path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ...empty, errors: [`${path}: ${(error as Error).message}`] };
  }
  if (!isRecord(raw)) return { ...empty, errors: [`${path}: expected a JSON object`] };
  const { table, errors } = parseRouteTable(raw);
  return {
    path,
    source,
    raw,
    routes: table.routes.map((route) => ({ route, source })),
    errors,
  };
}

/**
 * Effective routes across both files, with the file each one came from.
 *
 * `shadowed` lists global routes a project route replaces: deleting the
 * project copy makes those routes take over again, which is exactly the kind
 * of surprise the TUI has to be able to explain before the user presses
 * delete.
 */
export function routeSources(globalPath: string, projectPath: string): {
  routes: SourcedRoute[];
  shadowed: SourcedRoute[];
  errors: string[];
} {
  const global = readRouteDoc(globalPath, "global");
  const project = readRouteDoc(projectPath, "project");
  const effective = new Map<string, SourcedRoute>();
  // Insertion order of the first sighting, value of the last: the same result
  // as `mergeRouteTables`, so the TUI and the runtime agree on row order.
  for (const entry of [...global.routes, ...project.routes]) effective.set(entry.route.name, entry);
  const projectNames = new Set(project.routes.map((entry) => entry.route.name));
  return {
    routes: [...effective.values()],
    shadowed: global.routes.filter((entry) => projectNames.has(entry.route.name)),
    errors: [...global.errors, ...project.errors],
  };
}

/**
 * Write one route into `path`, preserving every other key in the document.
 *
 * The route is replaced in place when the name already exists and appended
 * otherwise, so a save never reorders the user's file. Throws with an
 * actionable message when the file cannot be safely rewritten.
 */
export function saveRoute(path: string, route: RouteConfig): void {
  const raw = loadWritable(path);
  const entry = serializeRoute(validateRoute(route));
  const routes = Array.isArray(raw.routes) ? [...raw.routes] : [];
  const index = routes.findIndex((candidate) => isRecord(candidate) && routeName(candidate) === route.name);
  if (index >= 0) routes[index] = entry;
  else routes.push(entry);
  writeDoc(path, { ...raw, routes });
}

/** Delete one route from `path`. Returns false when nothing matched. */
export function removeRoute(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  const raw = loadWritable(path);
  const routes = Array.isArray(raw.routes) ? raw.routes : [];
  const kept = routes.filter((candidate) => !(isRecord(candidate) && routeName(candidate) === name));
  if (kept.length === routes.length) return false;
  writeDoc(path, { ...raw, routes: kept });
  return true;
}

/** The name a raw route entry declares, trimmed, or undefined. */
function routeName(entry: Record<string, unknown>): string | undefined {
  return typeof entry.name === "string" ? entry.name.trim() : undefined;
}

/**
 * Round-trip one route through the parser before it is written.
 *
 * Serialising the *normalised* result means the file always contains a route
 * the reader accepts, and that a caller cannot persist, say, an empty target
 * list that would only fail at request time.
 */
function validateRoute(route: RouteConfig): RouteConfig {
  const { table, errors } = parseRouteTable({ routes: [route] });
  const parsed = table.routes[0];
  if (errors.length || !parsed) throw new Error(errors[0] ?? `route "${route.name}" is not valid`);
  return parsed;
}

/**
 * JSON for one route: the small form when it says everything.
 *
 * A target with no pool and no thinking level is written as the plain string
 * `"provider/model"`, and `method`/`when` are omitted while they hold their
 * defaults. A config stays readable, and a route that never touched the new
 * fields keeps the shape it had before they existed.
 */
function serializeRoute(route: RouteConfig): Record<string, unknown> {
  return {
    name: route.name,
    ...(route.label ? { label: route.label } : {}),
    ...(route.description ? { description: route.description } : {}),
    targets: route.targets.map(serializeTarget),
    ...(route.sticky !== undefined ? { sticky: route.sticky } : {}),
    ...(route.pool ? { pool: route.pool } : {}),
    ...(route.method && route.method !== "priority" ? { method: route.method } : {}),
    ...(route.when && route.when !== "turn" ? { when: route.when } : {}),
  };
}

function serializeTarget(target: RouteTarget): string | Record<string, unknown> {
  if (!target.pool && !target.thinking) return target.model;
  return {
    model: target.model,
    ...(target.pool ? { pool: target.pool } : {}),
    ...(target.thinking ? { thinking: target.thinking } : {}),
  };
}

/** Load a document that is about to be rewritten, refusing a broken one. */
function loadWritable(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`refusing to write ${path}: it is not valid JSON (${(error as Error).message}). Fix it by hand first.`);
  }
  if (!isRecord(raw)) throw new Error(`refusing to write ${path}: expected a JSON object, found ${Array.isArray(raw) ? "an array" : typeof raw}.`);
  return raw;
}

/** Atomic write: same-permissions temp file, then rename over the target. */
function writeDoc(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
