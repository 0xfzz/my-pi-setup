import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";

const SDK_ROOT = join(process.cwd(), "packages", "pi-web-bridge", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Static, side-effect, dynamic and require imports, including type-only ones. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return [...new Set(patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? "")))].filter((specifier) => specifier !== "");
}

const FORBIDDEN_PREFIXES = ["web/core", "@earendil-works", "react", "fastify"] as const;

/** The SDK is pure protocol: no host, web bundle or node runtime may leak in. */
function forbiddenImports(source: string): string[] {
  return importSpecifiers(source).filter((specifier) =>
    specifier.startsWith("node:")
    || isBuiltin(specifier)
    || FORBIDDEN_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)));
}

test("the SDK has no host, UI framework or node runtime imports", () => {
  const violations = sourceFiles(SDK_ROOT).flatMap((file) =>
    forbiddenImports(readFileSync(file, "utf8"))
      .map((specifier) => `${relative(process.cwd(), file)}: ${specifier}`));
  assert.deepEqual(violations, []);
});

test("the boundary detector rejects a synthetic SDK source with forbidden imports", () => {
  const badSource = [
    'import { MESSAGE_CATALOG } from "web/core/protocol/catalog.ts";',
    'import type { AgentSession } from "@earendil-works/pi-coding-agent";',
    'import React from "react";',
    'import Fastify from "fastify";',
    'import { readFile } from "node:fs/promises";',
    'const optional = await import("path");',
  ].join("\n");
  assert.deepEqual(forbiddenImports(badSource), [
    "web/core/protocol/catalog.ts",
    "@earendil-works/pi-coding-agent",
    "react",
    "fastify",
    "node:fs/promises",
    "path",
  ]);
});

test("the SDK owns exactly one catalog and one UI text implementation", () => {
  const files = sourceFiles(SDK_ROOT).map((file) => readFileSync(file, "utf8"));
  const count = (pattern: RegExp): number =>
    files.reduce((total, source) => total + [...source.matchAll(pattern)].length, 0);
  assert.equal(count(/export const MESSAGE_CATALOG\b/g), 1);
  assert.equal(count(/export function webUiText\b/g), 1);
});
