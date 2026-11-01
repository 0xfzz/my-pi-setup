import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import { ProviderKeyInput, providerKeyInput } from "../lib/provider/provider-key-input.ts";

const widths = [0, 1, 2, 3, 5, 8, 15, 40, 80, 200];
const title = "Provider key";

function fixture() {
  const results: (string | undefined)[] = [];
  let renders = 0;
  const component = new ProviderKeyInput(title, value => results.push(value), () => renders++);
  component.focused = true;
  return { component, results, renders: () => renders };
}

function checkMasked(component: ProviderKeyInput, secret = "") {
  for (const width of widths) {
    const lines = component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `line fits width ${width}`);
    if (width === 0) {
      assert.deepEqual(lines, [""]);
      continue;
    }
    assert.equal(lines.length, 3);
    const inputLine = lines[1];
    const plain = stripVTControlCharacters(inputLine.replaceAll(CURSOR_MARKER, "").replaceAll(renderFakeCursor(" "), " "));
    assert.match(plain, /^[* ]*$/);
    if (secret) assert.ok(!lines.join("\n").includes(secret), "render excludes the secret");
    if (component.focused) {
      assert.equal(inputLine.split(CURSOR_MARKER).length, 2);
      assert.ok(inputLine.endsWith(CURSOR_MARKER + renderFakeCursor(" ")));
    } else {
      assert.ok(!inputLine.includes(CURSOR_MARKER));
    }
  }
}

const paste = (component: ProviderKeyInput, value: string) => component.handleInput(`\x1b[200~${value}\x1b[201~`);

// Only custom() is permitted: any fallback dialog, logging, or session API access fails.
function contextFixture(mode: string, interact: (component: ProviderKeyInput) => void) {
  let customCalls = 0;
  type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
  const custom = (factory: Factory) => new Promise<unknown>((resolve, reject) => {
    customCalls++;
    const tui = { requestRender() {} } as Parameters<Factory>[0];
    const theme = {} as Parameters<Factory>[1];
    const keybindings = {} as Parameters<Factory>[2];
    const component = factory(tui, theme, keybindings, resolve);
    assert.ok(component instanceof ProviderKeyInput);
    try { interact(component); } catch (error) { reject(error); }
  });
  const ui = new Proxy({}, {
    get(_target, key) {
      assert.equal(key, "custom", "no non-custom UI access");
      return custom;
    },
  });
  const ctx = new Proxy({}, {
    get(_target, key) {
      if (key === "mode") return mode;
      if (key === "ui") return ui;
      assert.fail("no session, logging, or persistence access");
    },
  }) as ExtensionCommandContext;
  return { ctx, customCalls: () => customCalls };
}

test("typed input stays masked at every width and after invalidation/focus changes", () => {
  const h = fixture();
  let secret = "";
  for (const char of "sk-FIXTURE-739_secret") {
    secret += char;
    h.component.handleInput(char);
    checkMasked(h.component, secret.length > 3 ? secret : "");
  }
  assert.equal(h.renders(), secret.length);
  h.component.invalidate();
  h.component.focused = false;
  checkMasked(h.component, secret);
  h.component.focused = true;
  checkMasked(h.component, secret);
  h.component.handleInput("\r");
  assert.deepEqual(h.results, [secret]);
});

test("pasted ASCII, Unicode and ANSI/OSC/control payloads never reach rendered output", () => {
  for (const secret of [
    "sk-PASTED-fixture-9Z".repeat(200),
    "密钥🔑e\u0301-秘密-fixture",
    "\x1b[31mANSI_SECRET\x1b[0m",
    "\x1b]8;;https://fixture.invalid/OSC_SECRET\x07link\x1b]8;;\x07",
    "\x1b]52;c;CLIPBOARD_SECRET\x07",
    CURSOR_MARKER + "MARKER_SECRET\x00\x03\x7f",
  ]) {
    const h = fixture();
    paste(h.component, secret);
    checkMasked(h.component, secret);
    const sameLength = fixture();
    paste(sameLength.component, "X".repeat(secret.length));
    for (const width of widths) {
      assert.deepEqual(h.component.render(width), sameLength.component.render(width), "only length affects masking");
    }
    h.component.handleInput("\r");
    assert.deepEqual(h.results, [secret]);
  }
});

test("chunked bracketed paste stays masked while buffering and reuses Input paste normalization", () => {
  const h = fixture();
  h.component.handleInput("\x1b[200~");
  h.component.handleInput("FIRST_SECRET\r\n");
  h.component.handleInput("SECOND_SECRET\tEND");
  checkMasked(h.component, "FIRST_SECRET");
  assert.deepEqual(h.results, []);
  h.component.handleInput("\x1b[201~");
  checkMasked(h.component, "SECOND_SECRET");
  h.component.handleInput("\r");
  assert.deepEqual(h.results, ["FIRST_SECRETSECOND_SECRET    END"]);
});

test("Input editing: movement, insertion, backspace, forward delete, home and end", () => {
  const h = fixture();
  paste(h.component, "abcd");
  h.component.handleInput("\x1b[D"); // Left: abc|d
  h.component.handleInput("X"); // abcX|d
  h.component.handleInput("\x7f"); // abc|d
  h.component.handleInput("\x1b[3~"); // abc|
  h.component.handleInput("\x01"); // Ctrl+A: |abc
  h.component.handleInput("Z"); // Z|abc
  h.component.handleInput("\x05"); // Ctrl+E: Zabc|
  h.component.handleInput("!");
  checkMasked(h.component, "Zabc!");
  h.component.handleInput("\r");
  assert.deepEqual(h.results, ["Zabc!"]);
});

test("Input grapheme deletion, kill/yank and undo stay functional without plaintext rendering", () => {
  const unicode = fixture();
  paste(unicode.component, "ab🔑e\u0301");
  unicode.component.handleInput("\x7f");
  unicode.component.handleInput("\x7f");
  unicode.component.handleInput("\r");
  assert.deepEqual(unicode.results, ["ab"]);

  const h = fixture();
  paste(h.component, "SECRET_WORD");
  h.component.handleInput("\x15"); // Ctrl+U: kill to start
  checkMasked(h.component);
  h.component.handleInput("\x19"); // Ctrl+Y: yank
  h.component.handleInput("\x7f");
  h.component.handleInput("\x1f"); // Ctrl+-: undo deletion
  checkMasked(h.component, "SECRET_WORD");
  h.component.handleInput("\r");
  assert.deepEqual(h.results, ["SECRET_WORD"]);
});

for (const [name, key] of [["escape", "\x1b"], ["ctrl+c", "\x03"]]) {
  test(`${name} cancels, releases state and only completes once (also during paste)`, () => {
    for (const buffering of [false, true]) {
      const h = fixture();
      paste(h.component, "CANCEL_SECRET");
      if (buffering) h.component.handleInput("\x1b[200~BUFFER_SECRET");
      h.component.handleInput(key);
      assert.deepEqual(h.results, [undefined]);
      assert.deepEqual(h.component.render(80), [""]);
      assert.equal(h.component.focused, false);
      h.component.handleInput("\r");
      h.component.handleInput(key);
      assert.deepEqual(h.results, [undefined]);
    }
  });
}

test("blank and whitespace values submit unchanged; dispose does not submit", () => {
  for (const value of ["", "   "]) {
    const h = fixture();
    if (value) paste(h.component, value);
    h.component.handleInput("\r");
    h.component.handleInput("\r");
    assert.deepEqual(h.results, [value]);
    assert.deepEqual(h.component.render(80), [""]);
  }
  const h = fixture();
  paste(h.component, "DISPOSE_SECRET");
  h.component.dispose();
  h.component.dispose();
  h.component.focused = true;
  h.component.invalidate();
  h.component.handleInput("\r");
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.component.render(80), [""]);
});

test("multiline/ANSI/wide title and footer fit narrow widths", () => {
  const component = new ProviderKeyInput("\x1b[32m宽标题🔑\x1b[0m\r\nSecond title\nThird", () => {}, () => {});
  component.focused = true;
  for (const width of widths) {
    for (const line of component.render(width)) {
      assert.ok(visibleWidth(line) <= width);
      assert.ok(!/[\r\n]/.test(line));
    }
  }
});

test("never calls Input.render, including after paste/editing", () => {
  const original = Input.prototype.render;
  Input.prototype.render = () => { throw new Error("PLAINTEXT_RENDER_MUST_NOT_RUN"); };
  try {
    const h = fixture();
    paste(h.component, "RENDER_SECRET");
    h.component.handleInput("\x1b[D");
    checkMasked(h.component, "RENDER_SECRET");
  } finally { Input.prototype.render = original; }
});

test("providerKeyInput uses only custom UI and resolves submitted/cancelled values", async () => {
  for (const key of ["\r", "\x1b", "\x03"]) {
    let captured: ProviderKeyInput | undefined;
    const h = contextFixture("tui", component => {
      captured = component;
      component.focused = true;
      paste(component, "HELPER_SECRET");
      checkMasked(component, "HELPER_SECRET");
      component.handleInput(key);
    });
    assert.equal(await providerKeyInput(h.ctx, title), key === "\r" ? "HELPER_SECRET" : undefined);
    assert.equal(h.customCalls(), 1);
    assert.deepEqual(captured?.render(80), [""]);
  }
  const h = contextFixture("tui", component => component.handleInput("\r"));
  assert.equal(await providerKeyInput(h.ctx, title), "");
});

test("non-TUI modes reject safely with login/environment guidance and no UI access", async () => {
  for (const mode of ["rpc", "json", "print", undefined]) {
    const h = contextFixture(mode as string, () => assert.fail("must not open UI"));
    await assert.rejects(providerKeyInput(h.ctx, "SECRET_TITLE"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /TUI/);
      assert.match(error.message, /\/login/);
      assert.match(error.message, /environment authentication/);
      assert.ok(!error.message.includes("SECRET_TITLE"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(h.customCalls(), 0);
  }
});

test("helper replaces custom-UI errors without leaking message/cause and disposes state", async () => {
  let captured: ProviderKeyInput | undefined;
  const h = contextFixture("tui", component => {
    captured = component;
    paste(component, "ERROR_SECRET");
    throw new Error("ERROR_SECRET", { cause: "ERROR_SECRET" });
  });
  await assert.rejects(providerKeyInput(h.ctx, "SECRET_TITLE"), error => {
    assert.ok(error instanceof Error);
    assert.ok(!String(error).includes("SECRET"));
    assert.equal(error.cause, undefined);
    assert.match(error.message, /\/login.*environment authentication/);
    return true;
  });
  assert.deepEqual(captured?.render(80), [""]);
});

test("Input errors are replaced with secret-free errors and state is disposed", () => {
  const original = Input.prototype.handleInput;
  Input.prototype.handleInput = () => { throw new Error("INPUT_ERROR_SECRET"); };
  try {
    const h = fixture();
    assert.throws(() => h.component.handleInput("INPUT_ERROR_SECRET"), error => {
      assert.ok(error instanceof Error);
      assert.ok(!String(error).includes("INPUT_ERROR_SECRET"));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(h.component.render(80), [""]);
    assert.deepEqual(h.results, []);
  } finally { Input.prototype.handleInput = original; }
});
