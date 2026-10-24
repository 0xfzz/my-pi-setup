// Bridges the VCC adapter (an ESM extension) to the pi runtime's compiled CJS
// internals, which are not reachable through the package's `exports` map.
//
// Resolution order:
//   1. PI_RUNTIME_ROOT — an explicit install's node_modules directory
//   2. this repository's own node_modules — the runtime that loaded the extension
//
// Both end up requiring an absolute file path, because a bare
// `@earendil-works/pi-coding-agent/dist/...` specifier is refused with
// ERR_PACKAGE_PATH_NOT_EXPORTED. Nothing here may depend on one machine's home
// directory.
const fs = require("node:fs");
const path = require("node:path");

const PACKAGE = "@earendil-works/pi-coding-agent";

/** Walk up from this file looking for `<dir>/node_modules/<name>`. */
function findInstalledPackage(name) {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const explicitRuntime = process.env.PI_RUNTIME_ROOT ?? null;
const packageDir = explicitRuntime
  ? path.join(explicitRuntime, PACKAGE)
  : findInstalledPackage(PACKAGE);

if (!packageDir || !fs.existsSync(path.join(packageDir, "package.json"))) {
  throw new Error(
    `pi-bridge: cannot locate ${PACKAGE}. Set PI_RUNTIME_ROOT to an install's node_modules directory, ` +
      `or run from a checkout that has it installed.`,
  );
}

const load = (file) => require(path.join(packageDir, "dist", "core", file));

const { convertToLlm } = load("messages.js");
const { sessionEntryToContextMessages } = load("session-manager.js");
module.exports = { convertToLlm, sessionEntryToContextMessages };
