/**
 * Pi loads extensions with jiti, not with `node --experimental-strip-types`.
 *
 * Importing through the real loader catches the class of bug where a Node ESM
 * namespace is not callable as a function in jiti (the dashboard crash), even
 * though the module typechecks and a strip-types import works.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("the real loader loads the naming authority and the extensions that use it", async () => {
  const naming: any = await jiti.import("../lib/naming.ts");
  assert.equal(typeof naming.meaningfulSessionTitle, "function", "meaningfulSessionTitle must be a callable function under jiti");

  const dashboard: any = await jiti.import("../extensions/dashboard.ts");
  assert.equal(typeof dashboard.default, "function", "dashboard must export an extension factory under jiti");

  const orchestrator: any = await jiti.import("../extensions/orchestrator.ts");
  assert.equal(typeof orchestrator.default, "function", "orchestrator must export an extension factory under jiti");
});
