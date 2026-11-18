/**
 * The single public registration surface for the web host.
 *
 * Registrations are grouped by concern in sibling `*.config.ts` files. Build
 * scripts, composition roots and tests import this barrel; no consumer owns a
 * registration list.
 */
export * from "./plugins.config.ts";
export * from "./host-modules.config.ts";
export * from "./viewer.config.ts";
export * from "./build.config.ts";
export * from "./fixtures.config.ts";
