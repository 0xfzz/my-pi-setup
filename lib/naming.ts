/**
 * Runtime bridge to the shared human-naming authority.
 *
 * The authority is `web/dashboard/src/naming.mjs`: one implementation shared by
 * the browser bundle, the Node tests and the extensions. Pi's extension loader
 * transpiles extensions to CJS and can resolve an `.mjs` dependency through an
 * interop shim that exposes the module namespace only as `default`. A named
 * `import { meaningfulSessionTitle }` then looks correct at type-check time and
 * is `undefined` at runtime, which crashed the dashboard on reload:
 *
 *   (0, _naming.meaningfulSessionTitle) is not a function
 *
 * Unwrapping once here keeps every caller on an ordinary typed import and makes
 * the failure impossible to reintroduce by adding another call site.
 */
import * as loaded from "../web/dashboard/src/naming.mjs";

type NamingModule = typeof loaded;

/** Accept both shapes the loader may hand us: the namespace, or `{ default: namespace }`. */
export function unwrapNaming(value: unknown): NamingModule {
  const candidate = (value as { default?: unknown } | undefined)?.default ?? value;
  return candidate as NamingModule;
}

/** Resolved lazily so a loader that populates the namespace late still works. */
function naming(): NamingModule {
  return unwrapNaming(loaded);
}

export function meaningfulSessionTitle(
  ...args: Parameters<NamingModule["meaningfulSessionTitle"]>
): ReturnType<NamingModule["meaningfulSessionTitle"]> {
  return naming().meaningfulSessionTitle(...args);
}

export function sessionTitle(
  ...args: Parameters<NamingModule["sessionTitle"]>
): ReturnType<NamingModule["sessionTitle"]> {
  return naming().sessionTitle(...args);
}

export function isHumanName(
  ...args: Parameters<NamingModule["isHumanName"]>
): ReturnType<NamingModule["isHumanName"]> {
  return naming().isHumanName(...args);
}

export function givenNamePart(
  ...args: Parameters<NamingModule["givenNamePart"]>
): ReturnType<NamingModule["givenNamePart"]> {
  return naming().givenNamePart(...args);
}

export function givenNameFor(
  ...args: Parameters<NamingModule["givenNameFor"]>
): ReturnType<NamingModule["givenNameFor"]> {
  return naming().givenNameFor(...args);
}

export function displayName(
  ...args: Parameters<NamingModule["displayName"]>
): ReturnType<NamingModule["displayName"]> {
  return naming().displayName(...args);
}
