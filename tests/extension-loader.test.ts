/**
 * Pi loads extensions with jiti, not with `node --experimental-strip-types`.
 *
 * Importing through the real loader catches the class of bug where a Node ESM
 * namespace is not callable as a function in jiti (the dashboard crash), even
 * though the module typechecks and a strip-types import works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The manifest is the only place Pi learns which files are extensions, so a file
 * added to `extensions/` but not listed silently never loads, and a listed file
 * that was renamed or deleted makes Pi fail at startup. Both mistakes are
 * invisible to tsc and to every other suite, so pin the set here.
 */
test("every extension on disk is listed in package.json, and every listed file exists", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const listed: string[] = pkg.pi.extensions;
  const normalise = (p: string) => p.replace(/^\.\//, "");

  const onDisk = (await readdir(join(root, "extensions")))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `extensions/${name}`)
    .sort();

  const listedExtensions = listed.map(normalise).filter((p) => p.startsWith("extensions/")).sort();

  assert.deepEqual(listedExtensions, onDisk,
    "extensions/ on disk and package.json → pi.extensions disagree; a new extension must be listed, a removed one unlisted");

  // Vendored entrypoints are listed explicitly too; a stale path is a startup failure.
  for (const entry of listed) {
    await assert.doesNotReject(readFile(join(root, normalise(entry)), "utf8"),
      `package.json lists ${entry}, which does not exist`);
  }
});

test("the real loader loads the naming authority and the extensions that use it", async () => {
  const naming: any = await jiti.import("../lib/naming.ts");
  assert.equal(typeof naming.meaningfulSessionTitle, "function", "meaningfulSessionTitle must be a callable function under jiti");

  const dashboard: any = await jiti.import("../extensions/dashboard.ts");
  assert.equal(typeof dashboard.default, "function", "dashboard must export an extension factory under jiti");

  const orchestrator: any = await jiti.import("../extensions/agent.ts");
  assert.equal(typeof orchestrator.default, "function", "orchestrator must export an extension factory under jiti");
});
