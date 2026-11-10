import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The web↔extension boundary, enforced on the import graph.
 *
 * One rule, two sides (docs/web-plugin-architecture.md):
 *   - the web is an INTERFACE: it renders state and forwards intents;
 *   - pi extensions own BEHAVIOR: anything that changes what pi does.
 * The coupling between the sides is contracts and the bridge — never each
 * other's runtime code. These tests fail when source code reaches across,
 * so the boundary is enforced on every `npm test`, not by review discipline.
 *
 * Two import classes with different rules:
 *   - RUNTIME imports move code across a boundary — strictly bounded.
 *   - TYPE-ONLY imports (`import type` / `export type ... from`) are erased
 *     at build; they are allowed from CONTRACT layers only (the wire and
 *     plugin contracts both sides speak), never from behavior code.
 *
 * Specifiers are resolved against the importing file (relative depths vary),
 * so the rules are stated on target trees, not raw specifier shapes.
 */

const NODE_BUILTIN = /^(?:node:|fs|path|os|url|util|crypto|child_process|events|stream)$/;

type ImportKind = "runtime" | "type-only";

interface ImportEdge {
  /** Repo-relative path of the importing file. */
  file: string;
  /** Resolved repo-relative target, or the bare specifier for package imports. */
  target: string;
  /** The raw specifier as written — relative imports are resolved, bare ones stay. */
  specifier: string;
  kind: ImportKind;
}

/** Every import edge in a tree: static, dynamic, require — kind included. */
function importsOf(file: string): ImportEdge[] {
  const text = readFileSync(file, "utf8");
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  const push = (specifier: string, kind: ImportKind): void => {
    const key = `${kind}:${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    const target = specifier.startsWith(".")
      ? relative(process.cwd(), resolve(dirname(file), specifier))
      : specifier;
    edges.push({ file: relative(process.cwd(), file), target, specifier, kind });
  };

  // import type / export type ... from "x" — erased at build.
  const typeOnly = /(?:import|export)\s+type\s[^;]*?from\s*["']([^"']+)["']/g;
  // Plain import ... from "x", side-effect import "x", dynamic import("x"), require("x").
  const runtime = [
    /(?:^|[\n;])import\s(?!\s*type\b)[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\n;])import\s*["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of [typeOnly, ...runtime]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) push(specifier, pattern === typeOnly ? "type-only" : "runtime");
      match = pattern.exec(text);
    }
  }
  return edges;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) && !/\.test\.(ts|mjs|js)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Where an import may point, per source tree. null = nothing allowed. */
interface ZoneRules {
  dir: string;
  /** Runtime import targets (prefixes on resolved targets / package names). */
  runtimeAllow: readonly string[] | null;
  /** Type-only targets in addition to runtimeAllow. */
  typeOnlyAllow: readonly string[] | null;
  why: string;
}

const CONTRACT_LAYERS = ["web/shared/", "lib/web-plugins/"];

function union(a: readonly string[], b: readonly string[] | null): readonly string[] {
  return b === null ? a : [...a, ...b];
}

const ZONES: readonly ZoneRules[] = [
  {
    // The browser bundle: interface only. React and the wire/plugin
    // contracts are its entire world; pi behavior never enters it.
    dir: "web/client",
    runtimeAllow: ["web/client/", "web/shared/"],
    typeOnlyAllow: CONTRACT_LAYERS,
    why: "the client is interface only: it renders wire/plugin contracts and never runs pi behavior",
  },
  {
    // Wire contracts (client↔server): pure. Composing plugin-contract
    // types is fine; depending on runtimes is not.
    dir: "web/shared",
    runtimeAllow: ["web/shared/"],
    typeOnlyAllow: ["lib/web-plugins/"],
    why: "wire contracts stay pure — they compose the plugin contract's types but no runtime",
  },
  {
    // The server is a host (it may run pi and call built-ins) and serves
    // the plugin descriptors; it serves the BUILT client and never imports
    // its source.
    dir: "web/server",
    runtimeAllow: ["web/server/", "web/shared/", "web-plugins/", "lib/", "@earendil-works/", "node:"],
    typeOnlyAllow: null,
    why: "the server hosts sessions, serves plugin descriptors and the built client; importing client source couples build to runtime",
  },
  {
    // pi extensions own behavior. Their web surface is the HTTP bridge +
    // lib contracts; web source (client, server, wire, descriptors) is off
    // limits — vendored pi-side code is behavior's own to use.
    dir: "extensions",
    runtimeAllow: ["extensions/", "lib/", "vendor/", "@earendil-works/", "node:"],
    typeOnlyAllow: ["lib/", "vendor/"],
    why: "extensions own behavior; the web is reached only through the bridge and lib contracts",
  },
  {
    // Web plugin descriptors: declarative interface data. Contracts and
    // shared constants; no pi, no web runtime, no node.
    dir: "web-plugins",
    runtimeAllow: ["web-plugins/", "lib/"],
    typeOnlyAllow: ["lib/"],
    why: "web plugins are declarative descriptors: interface bridging only, no behavior imports",
  },
  {
    // The plugin contract layer: shared by pi-side publishers and web
    // renderers. It must not depend on either side's runtime.
    dir: "lib/web-plugins",
    runtimeAllow: ["lib/web-plugins/", "node:"],
    typeOnlyAllow: null,
    why: "the plugin contract layer cannot depend on the web or pi runtimes",
  },
  {
    // The pi_api facade: the one place that imports pi's built-in modules
    // for the web. It implements the wire contract; never the web runtime.
    dir: "lib/web-pi-apis",
    runtimeAllow: ["lib/", "web/shared/", "@earendil-works/", "node:"],
    typeOnlyAllow: null,
    why: "the facade calls pi built-ins and implements the wire contract — the web runtime stays out",
  },
];

function allowed(zone: ZoneRules, edge: ImportEdge): boolean {
  // Type-only edges get the runtime allowances too (intra-zone types are
  // always fine); runtime edges get only the runtime list. A zone's
  // allowance list is declared nullable but every zone sets one; coalesce
  // defensively so the declared type cannot fault the import audit.
  const runtime = zone.runtimeAllow ?? [];
  const allow = edge.kind === "runtime" ? runtime : union(runtime, zone.typeOnlyAllow);
  const isPiPackage = edge.specifier.startsWith("@earendil-works/")
    || edge.target.startsWith("node_modules/@earendil-works/");
  if (isPiPackage) return allow.includes("@earendil-works/");
  if (!edge.specifier.startsWith(".")) {
    // Bare specifier: a package import. pi packages are handled above; node
    // built-ins are policy; every other npm dependency is the zone's own.
    if (edge.specifier.startsWith("node:")) return allow.includes("node:");
    if (NODE_BUILTIN.test(edge.specifier)) return allow.includes("node:");
    return true;
  }
  // Relative specifier: resolved to a repo path — must land in an allowed tree.
  if (edge.target.startsWith("node_modules/")) {
    // Deep file imports of npm packages (allowed only where pi is).
    return allow.some((prefix) => edge.target.startsWith(prefix === "@earendil-works/" ? "node_modules/@earendil-works/" : prefix));
  }
  return allow.some((prefix) => edge.target.startsWith(prefix));
}

test("the web↔extension boundary holds on the import graph", () => {
  const violations: string[] = [];

  for (const zone of ZONES) {
    for (const file of sourceFiles(join(process.cwd(), zone.dir))) {
      for (const edge of importsOf(file)) {
        if (!allowed(zone, edge)) {
          violations.push(
            `${edge.file}: ${edge.kind} import "${edge.target}" — ${zone.why}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "boundary violations found; the rule: web = interface, extensions = behavior (docs/web-plugin-architecture.md)",
  );
});
