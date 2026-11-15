// A plugin reload must import fresh code, not the module the process already
// holds. These tests use real files in a temp directory: the point is Node's
// module cache, so a fake loader would prove nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearPluginModuleGenerationsForTests, importPluginModule } from "./plugin-module-loader.ts";

async function pluginDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plugin-module-loader-"));
}

/** The shape every fixture plugin returns: a value read from its own module tree. */
interface FixturePlugin {
  value(): string;
  /** A module the plugin imports from OUTSIDE its directory. */
  coreValue(): string;
}

test("a reload re-evaluates the plugin entry and its own sibling modules", async () => {
  const dir = await pluginDir();
  try {
    await writeFile(join(dir, "sibling.ts"), 'export const label = "v1";\n');
    await writeFile(
      join(dir, "index.ts"),
      'import { label } from "./sibling.ts";\nexport default { value: () => label, coreValue: () => "" };\n',
    );
    const entry = join(dir, "index.ts");

    const first = (await importPluginModule(entry, dir)) as FixturePlugin;
    assert.equal(first.value(), "v1");

    // The operator edits the plugin, including a module it imports itself.
    await writeFile(join(dir, "sibling.ts"), 'export const label = "v2";\n');
    const second = (await importPluginModule(entry, dir)) as FixturePlugin;

    assert.equal(second.value(), "v2", "the reloaded plugin runs the edited sibling");
    assert.notEqual(second, first, "a reload is a new module instance, not the cached one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a plugin keeps the module identity of core code it imports", async () => {
  const dir = await pluginDir();
  const core = await mkdtemp(join(tmpdir(), "plugin-module-loader-core-"));
  try {
    // A core module beside the plugin, outside the plugin's own directory.
    await writeFile(join(core, "shared.ts"), 'export const token = {};\n');
    const relative = `../${core.split("/").pop()}/shared.ts`;
    await writeFile(
      join(dir, "index.ts"),
      `import { token } from "${relative}";\nexport default { value: () => "", coreValue: () => token };\n`,
    );
    const entry = join(dir, "index.ts");

    const first = (await importPluginModule(entry, dir)) as FixturePlugin;
    const second = (await importPluginModule(entry, dir)) as FixturePlugin;

    // The core module is NOT scoped by the generation: a second copy would give
    // the plugin its own kernel state instead of the host's.
    assert.equal(second.coreValue(), first.coreValue());
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(core, { recursive: true, force: true });
  }
});

test("generations are per plugin directory, so one plugin's reload does not touch another", async () => {
  const a = await pluginDir();
  const b = await pluginDir();
  try {
    for (const dir of [a, b]) {
      await writeFile(join(dir, "index.ts"), 'export default { value: () => "same", coreValue: () => "" };\n');
    }

    const firstA = (await importPluginModule(join(a, "index.ts"), a)) as FixturePlugin;
    const firstB = (await importPluginModule(join(b, "index.ts"), b)) as FixturePlugin;
    // Reloading A must not invalidate B's modules: B is a different plugin.
    const secondA = (await importPluginModule(join(a, "index.ts"), a)) as FixturePlugin;
    const secondB = (await importPluginModule(join(b, "index.ts"), b)) as FixturePlugin;

    assert.notEqual(secondA, firstA);
    assert.notEqual(secondB, firstB);
    assert.equal(secondA.value(), "same");
    assert.equal(secondB.value(), "same");
  } finally {
    clearPluginModuleGenerationsForTests();
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
