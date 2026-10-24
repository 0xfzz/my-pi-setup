import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import modes from "../extensions/modes.ts";

test("real Pi native Plan shell executes normalized read-only input and blocks mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-plan-native-"));
  let session: any;
  const errors: unknown[] = [];
  let unguardedShell = 0;
  try {
    await writeFile(join(dir, "source.txt"), "source stays unchanged\n");
    const settings = SettingsManager.inMemory({ cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [modes, pi => {
        pi.on("user_bash", () => { unguardedShell++; return undefined; });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.inMemory(dir) }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.prompt("/plan on");
    const event = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "cat source.txt | head -n 1", cwd: dir, excludeFromContext: true });
    assert.ok(event?.operations);
    let output = "";
    // Even a caller passing different raw text can only execute the captured,
    // checked command; no unvalidated shell input falls through to execution.
    const result = await event.operations.exec("touch escaped.txt", dir, { onData(data: Uint8Array) { output += Buffer.from(data).toString(); } });
    assert.equal(result.exitCode, 0);
    assert.match(output, /source stays unchanged/);
    for (const command of ["touch escaped.txt", "cat source.txt > escaped.txt", "find . -delete"]) {
      const blocked = await session.extensionRunner.emitUserBash({ type: "user_bash", command, cwd: dir, excludeFromContext: true });
      assert.equal(blocked.result.exitCode, 1);
      assert.match(blocked.result.output, /Plan mode blocks shell/);
    }
    await assert.rejects(access(join(dir, "escaped.txt")));
    assert.equal(await readFile(join(dir, "source.txt"), "utf8"), "source stays unchanged\n");
    assert.equal(unguardedShell, 0);
    await session.prompt("/plan off");
    assert.equal(await session.extensionRunner.emitUserBash({ type: "user_bash", command: "touch escaped.txt", cwd: dir, excludeFromContext: true }), undefined);
    assert.equal(unguardedShell, 1);
    assert.deepEqual(errors, []);
  } finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
