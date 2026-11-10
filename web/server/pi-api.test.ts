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
