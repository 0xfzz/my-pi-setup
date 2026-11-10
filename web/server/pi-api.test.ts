import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePiApiRequest } from "./pi-api.ts";
import { parsePiApiBody } from "../shared/pi-api.ts";
test("parsePiApiBody validates the wire form", () => {
  assert.deepEqual(parsePiApiBody({ api: "commands.builtin", params: {} }), {
    api: "commands.builtin",
    params: {},
  });
  const good = parsePiApiBody({ api: "autocomplete.suggestions", params: { line: "read @a", cursorCol: 7 } });
  assert.ok(!("error" in good));
  assert.ok("error" in parsePiApiBody({ api: "nope" }));
  assert.ok("error" in parsePiApiBody({ api: "autocomplete.suggestions", params: { line: 3, cursorCol: 0 } }));
  assert.ok("error" in parsePiApiBody({ api: "autocomplete.suggestions", params: { line: "abc", cursorCol: 9 } }));
});

test("pi_api commands.builtin returns pi's own runtime list", async () => {
  const outcome = await handlePiApiRequest("/tmp", { api: "commands.builtin", params: {} });
  assert.equal(outcome.status, 200);
  assert.ok(outcome.body.ok);
  if (outcome.body.ok) {
    const commands = outcome.body.result as Array<{ name: string; description?: string }>;
    // pi's BUILTIN_SLASH_COMMANDS — loaded from pi's module, not copied.
    const names = commands.map((command) => command.name);
    for (const expected of ["compact", "model", "thinking", "new", "quit"]) {
      assert.ok(names.includes(expected), `pi builtin ${expected} present`);
    }
    assert.ok(commands.every((command) => typeof command.description === "string"));
  }
});

test("pi_api autocomplete.suggestions runs pi's provider on the session cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piapi-"));
  await writeFile(join(cwd, "alpha-note.txt"), "x", "utf8");
  await writeFile(join(cwd, "beta.json"), "{}", "utf8");
  // An @ mention mid-typing, caret at the line's end. pi's prefix
  // semantics: the char AT the caret is excluded from the prefix.
  const outcome = await handlePiApiRequest(cwd, {
    api: "autocomplete.suggestions",
    params: { line: "read @alpha", cursorCol: 11 },
  });
  assert.equal(outcome.status, 200);
  assert.ok(outcome.body.ok);
  if (outcome.body.ok) {
    const result = outcome.body.result as { items: Array<{ value: string; label: string }>; prefix: string } | null;
    assert.ok(result !== null, "pi's provider answers an @token");
    assert.equal(result?.prefix, "@alpha");
    const values = (result?.items ?? []).map((item) => item.value);
    assert.ok(
      values.some((value) => value === "@alpha-note.txt"),
      `suggests @alpha-note.txt (got: ${values.join(", ")})`,
    );
    assert.ok(!values.some((value) => value.includes("beta")), "non-matching files are filtered");
  }
});

test("pi_api rejects unknown apis and bad params", async () => {
  const unknown = await handlePiApiRequest("/tmp", { api: "no.such.api", params: {} });
  assert.equal(unknown.status, 400);
  assert.ok(!unknown.body.ok);
  const bad = await handlePiApiRequest("/tmp", { api: "autocomplete.suggestions", params: {} });
  assert.equal(bad.status, 400);
  assert.ok(!bad.body.ok);
});

test("pi_api settings.read/write round-trip through pi's SettingsManager", async () => {
  // The settings facade writes pi's GLOBAL settings file; point pi's agent
  // dir at a throwaway directory so the round-trip never touches the user's
  // real ~/.pi/agent/settings.json.
  const agentDir = await mkdtemp(join(tmpdir(), "piapi-settings-"));
  const cwd = await mkdtemp(join(tmpdir(), "piapi-settings-cwd-"));
  const envKey = "PI_CODING_AGENT_DIR";
  const previous = process.env[envKey];
  process.env[envKey] = agentDir;
  try {
    const read = await handlePiApiRequest(cwd, { api: "settings.read", params: {} });
    assert.equal(read.status, 200);
    assert.ok(read.body.ok);
    if (read.body.ok) {
      const { settings } = read.body.result as { settings: Array<{ key: string; kind: string; value: unknown }> };
      // pi's settings surface — the web port reads what pi's TUI selector shows.
      const byKey = new Map(settings.map((entry) => [entry.key, entry]));
      for (const key of [
        "transport", "sessionShareDestination", "compactionEnabled", "defaultProjectTrust",
        "editorPaddingX", "theme", "defaultThinkingLevel",
      ]) {
        assert.ok(byKey.has(key), `settings surface includes ${key}`);
      }
      // A toggle is read as a boolean.
      const autocompact = byKey.get("compactionEnabled");
      assert.equal(autocompact?.kind, "toggle");
      assert.equal(typeof autocompact?.value, "boolean");
    }

    // A write goes through pi's setter and flushes to the (throwaway) file;
    // the response reflects the stored value, and a re-read confirms it.
    const write = await handlePiApiRequest(cwd, {
      api: "settings.write",
      params: { key: "hideThinkingBlock", value: true },
    });
    assert.equal(write.status, 200);
    assert.ok(write.body.ok);
    if (write.body.ok) {
      const result = write.body.result as { key: string; value: unknown };
      assert.equal(result.key, "hideThinkingBlock");
      assert.equal(result.value, true);
    }

    const reread = await handlePiApiRequest(cwd, { api: "settings.read", params: {} });
    assert.ok(reread.body.ok);
    if (reread.body.ok) {
      const { settings } = reread.body.result as { settings: Array<{ key: string; value: unknown }> };
      const hideThinking = settings.find((entry) => entry.key === "hideThinkingBlock");
      assert.equal(hideThinking?.value, true);
    }

    // Bad writes are rejected at the wire layer AND by the facade.
    const badKey = await handlePiApiRequest(cwd, { api: "settings.write", params: { key: "nope", value: true } });
    assert.equal(badKey.status, 500);
    assert.ok(!badKey.body.ok);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});

test("pi_api trust.read/write round-trips pi's project-trust store", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piapi-trust-"));
  const cwd = await mkdtemp(join(tmpdir(), "piapi-trust-cwd-"));
  const envKey = "PI_CODING_AGENT_DIR";
  const previous = process.env[envKey];
  process.env[envKey] = agentDir;
  try {
    const read = await handlePiApiRequest(cwd, { api: "trust.read", params: {} });
    assert.equal(read.status, 200);
    assert.ok(read.body.ok);
    if (read.body.ok) {
      const state = read.body.result as {
        cwd: string;
        savedDecision: { path: string; decision: boolean } | null;
        options: Array<{ label: string; trusted: boolean; savedPath?: string }>;
      };
      assert.equal(state.cwd, cwd);
      assert.equal(state.savedDecision, null);
      // pi's trust options: trust this dir, (parent if any), do not trust.
      const labels = state.options.map((option) => option.label);
      assert.ok(labels.includes("Trust"), "offers Trust");
      assert.ok(labels.some((label) => label.startsWith("Do not trust")), "offers Do not trust");
    }

    // Write the "Trust" option; pi's store records a trusted entry for cwd.
    const write = await handlePiApiRequest(cwd, { api: "trust.write", params: { label: "Trust" } });
    assert.equal(write.status, 200);
    assert.ok(write.body.ok);
    if (write.body.ok) {
      const { savedDecision } = write.body.result as { savedDecision: { path: string; decision: boolean } | null };
      assert.equal(savedDecision?.decision, true);
      assert.equal(savedDecision?.path, cwd);
    }

    // A label pi never offered is rejected (no path/decision invention).
    const bogus = await handlePiApiRequest(cwd, { api: "trust.write", params: { label: "Not an option" } });
    assert.equal(bogus.status, 500);
    assert.ok(!bogus.body.ok);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});

test("pi_api settings.models round-trips the enabledModels patterns", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piapi-models-"));
  const cwd = await mkdtemp(join(tmpdir(), "piapi-models-cwd-"));
  const envKey = "PI_CODING_AGENT_DIR";
  const previous = process.env[envKey];
  process.env[envKey] = agentDir;
  try {
    const initial = await handlePiApiRequest(cwd, { api: "settings.models.read", params: {} });
    assert.equal(initial.status, 200);
    assert.ok(initial.body.ok);
    if (initial.body.ok) {
      // Unscoped default: null (every available model).
      assert.equal((initial.body.result as { enabled: string[] | null }).enabled, null);
    }

    const write = await handlePiApiRequest(cwd, {
      api: "settings.models.write",
      params: { patterns: ["openai/gpt-5", "anthropic/claude"] },
    });
    assert.equal(write.status, 200);
    assert.ok(write.body.ok);
    if (write.body.ok) {
      const { enabled } = write.body.result as { enabled: string[] | null };
      assert.deepEqual(enabled, ["openai/gpt-5", "anthropic/claude"]);
    }

    // Clearing scoping: null patterns → pi's unscoped default.
    const clear = await handlePiApiRequest(cwd, { api: "settings.models.write", params: { patterns: null } });
    assert.equal(clear.status, 200);
    assert.ok(clear.body.ok);
    if (clear.body.ok) {
      assert.equal((clear.body.result as { enabled: string[] | null }).enabled, null);
    }

    // Empty-string patterns are rejected.
    const bad = await handlePiApiRequest(cwd, { api: "settings.models.write", params: { patterns: [""] } });
    assert.equal(bad.status, 400);
    assert.ok(!bad.body.ok);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});
