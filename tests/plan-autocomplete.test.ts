import test from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createArtifactAutocompleteProvider } from "../lib/artifact-mentions.ts";

const options = () => ({ signal: new AbortController().signal, force: true });
function fixture() {
  let restricted = true;
  const native = new CombinedAutocompleteProvider([
    { name: "plan", description: "Plan mode", getArgumentCompletions: prefix => ["on", "off", "status"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) },
    { name: "mode", getArgumentCompletions: prefix => ["normal", "plan", "supervise"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) },
    { name: "artifacts" }, { name: "grill" }, { name: "skill:private" },
  ], "/tmp");
  // Any accidental path fallback, including Tab's real force:true option, must fail.
  (native as any).getFileSuggestions = () => { throw new Error("Unexpected filesystem completion"); };
  (native as any).getFuzzyFileSuggestions = () => { throw new Error("Unexpected FFF/file completion"); };
  const provider = createArtifactAutocompleteProvider(native, () => new Map(), () => restricted);
  return { native, provider, restrict(value: boolean) { restricted = value; } };
}

test("Plan retains slash names and argument completions on forced Tab without file fallback", async () => {
  const { provider } = fixture();
  const names = await provider.getSuggestions(["/"], 0, 1, options());
  assert.deepEqual(names?.items.map(item => item.value), ["plan", "mode", "artifacts", "grill"]);
  for (const [text, expected] of [["/pla", ["plan"]], ["/plan ", ["on", "off", "status"]], ["/mode n", ["normal"]], ["  /art", ["artifacts"]]] as const) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.deepEqual(result?.items.map(item => item.value), expected, text);
  }
  assert.equal(provider.shouldTriggerFileCompletion?.(["/plan "], 0, 6), true, "Tab must also be allowed for command arguments");
});

test("Plan applies command names and arguments while refusing stale file items", async () => {
  const { provider } = fixture();
  for (const [text, expected] of [["/pla", "/plan "], ["/plan of", "/plan off"], [" /mode nor", " /mode normal"]]) {
    const result = await provider.getSuggestions([text!], 0, text!.length, options());
    assert.ok(result, text);
    const applied = provider.applyCompletion([text!], 0, text!.length, result.items[0]!, result.prefix);
    assert.equal(applied.lines[0], expected);
  }
  const stale = { value: "@secret.txt", label: "@secret.txt" };
  assert.deepEqual(provider.applyCompletion(["@sec"], 0, 4, stale, "@sec"), { lines: ["@sec"], cursorLine: 0, cursorCol: 4 });
  assert.deepEqual(provider.applyCompletion(["/plan of"], 0, 8, stale, "of"), { lines: ["/plan of"], cursorLine: 0, cursorCol: 8 });
});

test("Plan never delegates shell, file, skill or non-command-line completions", async () => {
  const { provider, native } = fixture();
  let delegates = 0;
  const get = native.getSuggestions.bind(native);
  native.getSuggestions = async (...args) => { delegates++; return get(...args); };
  for (const text of ["./", "../", "/tmp/private/", "~/", "@private.txt", "/plan @private.txt", '/plan @"private file', "/skill:private", "! /plan", "!! /plan", "Review /plan"]) {
    assert.equal(await provider.getSuggestions([text], 0, text.length, options()), null, text);
  }
  assert.equal(await provider.getSuggestions(["Chat", "/plan"], 1, 5, options()), null);
  assert.equal(delegates, 0);
});

test("cancellation and mode changes suppress pending native file results", async () => {
  const { provider, native, restrict } = fixture();
  restrict(false);
  let finish!: (value: any) => void;
  native.getSuggestions = () => new Promise(resolve => { finish = resolve; });
  const pending = provider.getSuggestions(["@secret.txt"], 0, 11, options());
  restrict(true);
  finish({ prefix: "@secret.txt", items: [{ value: "@secret.txt", label: "secret.txt" }] });
  assert.equal(await pending, null, "no in-flight native files may surface after entering Plan");
  const controller = new AbortController();
  const command = provider.getSuggestions(["/pla"], 0, 4, { signal: controller.signal });
  controller.abort();
  finish({ prefix: "/pla", items: [{ value: "plan", label: "plan" }] });
  assert.equal(await command, null);
});

test("real editor Tab completion keeps Plan slash commands usable", async t => {
  const { provider } = fixture();
  const color = (text: string) => text;
  const editor: any = new CustomEditor({ requestRender() {}, terminal: { rows: 30, columns: 100 } } as any, {
    borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
  }, { matches: () => false } as any);
  t.after(() => editor.setText(""));
  editor.setAutocompleteProvider(provider);
  for (const [text, expected] of [["/pla", "/plan "], ["/plan of", "/plan off"]]) {
    editor.setText(text);
    editor.handleInput("\t");
    await editor.autocompleteRequestTask;
    // Native command-name Tab opens a menu; a second Tab selects the name.
    if (editor.isShowingAutocomplete()) editor.handleInput("\t");
    assert.equal(editor.getText(), expected);
  }
});
