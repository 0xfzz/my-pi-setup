import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PLAIN_THEME, type PopupTheme } from "../../lib/popup/frame.ts";
import type { ProviderConfig } from "../../lib/provider/provider-config.ts";
import type { ProviderPopupResult, ProviderSettingsView } from "../../lib/ui/provider-settings.ts";
import { ProviderSettingsPopup } from "../../lib/ui/provider-settings.ts";

const acme: ProviderConfig = {
  name: "Acme Cloud",
  api: "openai-completions",
  baseUrl: "https://api.acme.com/v1",
  apiKey: "$ACME_KEY",
  models: [
    { id: "acme-large", name: "Acme Large", contextWindow: 128000, maxTokens: 8192, reasoning: true },
    { id: "acme-small" },
  ],
};

const base = (): Record<string, ProviderConfig> => ({
  acme,
  "acme-2": { ...acme, name: "Acme Cloud (Account 2)", apiKey: "$ACME_KEY_2" },
  ollama: { name: "Local", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
});

function harness(providers: Record<string, ProviderConfig> = base(), extras: Partial<ProviderSettingsView> = {},
  start: "home" | "list" = "list") {
  const results: ProviderPopupResult[] = [];
  let closed = 0;
  const component = new ProviderSettingsPopup({
    view: () => ({
      path: "/home/u/.pi/agent/models.json",
      providers,
      errors: [],
      known: [],
      ...extras,
    }),
    theme: PLAIN_THEME,
    terminalRows: () => 40,
    onDone: (result) => { results.push(result); closed++; },
  });
  component.focused = true;
  // Page one is the home menu; most of these tests exercise the list behind it.
  if (start === "list") component.handleInput("\r");
  return {
    component, results, providers,
    get closed() { return closed; },
  };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const down = "\x1b[B";
const enter = "\r";
const escape = "\x1b";
const type = (component: ProviderSettingsPopup, text: string) => {
  for (const char of text) component.handleInput(char);
};
/** End, then kill to start: clears a field whose cursor may sit before its text. */
const clear = (component: ProviderSettingsPopup) => {
  component.handleInput("\x05");
  component.handleInput("\x15");
};

/** Walk the whole add wizard with the given answers and return the popup. */
function addProvider(answers: { id: string; name?: string; url: string; key: string }) {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, answers.id);
  h.component.handleInput(enter);
  if (answers.name !== undefined) {
    clear(h.component);
    type(h.component, answers.name);
  }
  h.component.handleInput(enter); // name
  h.component.handleInput(enter); // api choice: openai-completions
  type(h.component, answers.url);
  h.component.handleInput(enter); // base url
  type(h.component, answers.key);
  h.component.handleInput(enter); // key -> save
  return h;
}

// ── List ─────────────────────────────────────────────────────────────────────

test("the list names every provider, its protocol, models and endpoint", () => {
  const text = plain(harness().component.render(90));
  assert.match(text, /Providers/);
  assert.match(text, /PROVIDERS/);
  assert.match(text, /\/home\/u\/\.pi\/agent\/models\.json/, "the file it will write is visible");
  assert.match(text, /acme {2}Acme Cloud {2}account 1\/2/);
  assert.match(text, /acme-2 {2}Acme Cloud \(Account 2\) {2}account 2\/2/);
  assert.match(text, /OpenAI Chat Completions · 2 models · https:\/\/api\.acme\.com\/v1/);
  assert.match(text, /ollama {2}Local/);
  assert.match(text, /\+ add a provider…/);
  assert.match(text, /a add/);
  assert.match(text, /Esc back/, "the list is one step below page one");
});

test("config errors and the extension's notice are shown, not swallowed", () => {
  const text = plain(harness(base(), { errors: ["models.json is not strict JSON."] }).component.render(90));
  assert.match(text, /models\.json is not strict JSON\./);
});

// ── Provider screen ──────────────────────────────────────────────────────────

test("Enter opens a provider, showing how its stored auth resolves", () => {
  const h = harness();
  h.component.handleInput(enter);
  const text = plain(h.component.render(90));
  assert.match(text, /acme {2}Acme Cloud/);
  assert.match(text, /endpoint {2}https:\/\/api\.acme\.com\/v1/);
  assert.match(text, /auth\s+environment ACME_KEY/);
  assert.match(text, /Edit connection…/);
  assert.match(text, /Add models…/);
  assert.match(text, /Models \(2\)…/);
  assert.match(text, /Clone with a new key…/);
  assert.match(text, /creates acme-3, keeps this one's models/);
  assert.match(text, /Delete this provider/);
});

test("an id Pi also provides says that saving is an override", () => {
  const h = harness(base(), { known: ["ollama"] });
  h.component.handleInput(down);
  h.component.handleInput(down);
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /Pi also provides this id/);
});

test("a lone provider offers turning itself into a family, not a second family entry", () => {
  const h = harness({ ollama: base().ollama! });
  h.component.handleInput(enter);
  const text = plain(h.component.render(90));
  assert.match(text, /renames this to ollama-1 and creates ollama-2/,
    "the lone provider becomes Account 1 before the clone lands");
});

// ── The wizard ───────────────────────────────────────────────────────────────

test("a walks the connection steps and saves the draft, name defaulting to the id", () => {
  const h = addProvider({ id: "acme-cloud", url: "https://api.acme.com/v1", key: "$ACME_KEY" });
  assert.equal(h.closed, 1);
  const result = h.results[0];
  assert.equal(result?.kind, "save");
  if (result?.kind !== "save") return;
  assert.deepEqual(result.draft, {
    id: "acme-cloud",
    name: "acme-cloud", // taken from the id instead of asked twice
    api: "openai-completions",
    baseUrl: "https://api.acme.com/v1",
    apiKey: "$ACME_KEY",
  });
});

test("an invalid value names the problem and stays on the step", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "Acme Cloud");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /lowercase/);
  assert.equal(h.closed, 0, "nothing is saved while the id is invalid");

  clear(h.component);
  type(h.component, "ollama");
  h.component.handleInput(enter);
  assert.equal(h.closed, 0, "an existing id is refused on the same step");
  assert.match(plain(h.component.render(90)), /already configured/);

  clear(h.component);
  type(h.component, "acme-cloud");
  h.component.handleInput(enter);
  assert.equal(h.closed, 0, "a valid id only moves on");
  assert.match(plain(h.component.render(90)), /Display name/);
});

test("a malformed URL is refused on the URL step, with the reason", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(enter);
  h.component.handleInput(enter); // name
  h.component.handleInput(enter); // api
  type(h.component, "api.acme.com");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /complete http:\/\/ or https:\/\/ endpoint/);
  assert.equal(h.closed, 0);
});

test("Back keeps every answer, including the one just typed", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(enter);
  clear(h.component);
  type(h.component, "Acme Cloud");
  h.component.handleInput(escape); // back to the id
  assert.match(plain(h.component.render(90)), /acme-cloud/, "the id is still there");
  h.component.handleInput(enter); // forward again
  assert.match(plain(h.component.render(90)), /Acme Cloud/, "the name survived the trip");
});

test("leaving the wizard for the list keeps the draft while the popup is open", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(escape); // step 0 -> list
  assert.match(plain(h.component.render(90)), /\+ add a provider…/);
  h.component.handleInput("a");
  assert.match(plain(h.component.render(90)), /acme-cloud/, "reopening resumes the unfinished draft");
});

test("a key is painted as asterisks and never echoed", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  type(h.component, "https://api.acme.com/v1");
  h.component.handleInput(enter);
  type(h.component, "sk-secret-value");
  const text = plain(h.component.render(90));
  assert.doesNotMatch(text, /sk-secret-value/);
  assert.match(text, /\*{15}/);
  assert.match(text, /Step 5 of 5 · Enter saves/);
});

test("the protocol step is a menu of named protocols, and the current one is marked", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  const text = plain(h.component.render(90));
  assert.match(text, /API protocol/);
  assert.match(text, /OpenAI Chat Completions/);
  assert.match(text, /Anthropic Messages/);
  assert.match(text, /Google Generative AI/);
  assert.match(text, /current/, "the choice already in the draft is marked");
  h.component.handleInput(down);
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /Base URL/);
});

// ── Editing ──────────────────────────────────────────────────────────────────

test("edit connection starts at the name, because the id is the entry key", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("e");
  const text = plain(h.component.render(90));
  assert.match(text, /Display name/);
  assert.match(text, /Acme Cloud/, "the current name is prefilled");
  h.component.handleInput(escape);
  const idStep = plain(h.component.render(90));
  assert.match(idStep, /Provider ID \(locked\)/, "the id step is one Back away and says why");
});

test("saving an edit keeps the key step blank so the stored credential is untouched", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("e");
  clear(h.component);
  type(h.component, "Acme Cloud EU");
  h.component.handleInput(enter); // name
  h.component.handleInput(enter); // api (current)
  h.component.handleInput(enter); // url (kept)
  h.component.handleInput(enter); // blank key
  const result = h.results[0];
  assert.equal(result?.kind, "save");
  if (result?.kind !== "save") return;
  assert.equal(result.draft.id, "acme");
  assert.equal(result.draft.name, "Acme Cloud EU");
  assert.equal(result.draft.apiKey, "", "a blank key means keep the existing authentication");
});

// ── Models ───────────────────────────────────────────────────────────────────

test("the model list shows limits and removes one only after a confirmation", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("3"); // Models (2)…
  const text = plain(h.component.render(90));
  assert.match(text, /acme · 2 models/);
  assert.match(text, /acme-large {2}ctx 128k · out 8k · reasoning · Acme Large/);
  assert.match(text, /acme-small {2}no limits recorded/);

  h.component.handleInput(enter); // acme-large
  assert.match(plain(h.component.render(90)), /Remove acme-large from acme\?/);
  h.component.handleInput(enter);
  const result = h.results[0];
  assert.equal(result?.kind, "remove-model");
  if (result?.kind !== "remove-model") return;
  assert.deepEqual([result.id, result.modelId], ["acme", "acme-large"]);
});

test("add models leaves the popup with the provider, because discovery is its own overlay", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("2");
  assert.equal(h.closed, 1);
  assert.deepEqual(h.results[0], { kind: "add-models", id: "acme" });
});

test("deleting a provider asks first and names what is kept", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("d");
  const text = plain(h.component.render(90));
  assert.match(text, /Delete acme from models\.json\?/);
  assert.match(text, /Only this file entry is removed/);
  assert.match(text, /credentials/);
  assert.match(text, /untouched/, "the note says what a delete does not do");
  h.component.handleInput(enter);
  assert.deepEqual(h.results[0], { kind: "delete", id: "acme" });
});

test("an account draft is locked to the computed slot and starts with an empty key", () => {
  const h = harness();
  h.component.handleInput(enter);
  h.component.handleInput("4"); // Add an account…
  const text = plain(h.component.render(90));
  assert.match(text, /Display name/);
  assert.match(text, /Acme Cloud \(Account 3\)/, "the next free slot, named after the family");
  h.component.handleInput(escape);
  assert.match(plain(h.component.render(90)), /Provider ID \(locked\)/);
});

// ── Frame ────────────────────────────────────────────────────────────────────

test("the frame fits narrow and wide terminals without overflowing", () => {
  for (const width of [40, 60, 120]) {
    const h = harness();
    for (const line of h.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(stripTerminalSequences(line))}`);
    }
    h.component.handleInput(enter);
    for (const line of h.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `${width} columns in the provider screen`);
    }
  }
});

test("Escape walks back one page at a time, and only page one closes", () => {
  const h = harness();
  h.component.handleInput("a");
  type(h.component, "acme-cloud");
  h.component.handleInput(escape); // wizard -> list
  assert.equal(h.closed, 0, "leaving the wizard does not close the popup");
  assert.match(plain(h.component.render(90)), /PROVIDERS/);
  h.component.handleInput(escape); // list -> page one
  assert.equal(h.closed, 0);
  assert.match(plain(h.component.render(90)), /What would you like to do\?/);
  h.component.handleInput(escape); // page one -> close
  assert.equal(h.closed, 1);
  assert.deepEqual(h.results, [{ kind: "close" }], "closing is not an implicit save");
});

// ── Real theme ───────────────────────────────────────────────────────────────

test("the header renders with Pi's own theme, where an unknown token throws", () => {
  // Regression: `fg("danger")` compiled (PopupTheme took `string`) and only
  // threw at render time — when a config error was present, which the plain
  // test theme never exercised. This uses the installed theme instead.
  initTheme("dark");
  const realTheme = (globalThis as unknown as Record<symbol, PopupTheme>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ]!;
  assert.ok(realTheme, "initTheme installs the theme Pi hands to extensions");

  const component = new ProviderSettingsPopup({
    view: () => ({
      path: "/home/u/.pi/agent/models.json",
      providers: base(),
      errors: ["models.json is not strict JSON."],
      known: ["acme"],
    }),
    theme: realTheme,
    terminalRows: () => 40,
    notice: "Removed acme from models.json.",
    onDone: () => {},
  });
  component.focused = true;
  const text = plain(component.render(90));
  assert.match(text, /models\.json is not strict JSON\./);
  assert.match(text, /Removed acme from models\.json\./);
});

// ── Page one ─────────────────────────────────────────────────────────────────

test("page one offers only the two things you can do", () => {
  const h = harness(base(), {}, "home");
  const text = plain(h.component.render(90));
  assert.match(text, /What would you like to do\?/);
  assert.match(text, /List available providers/);
  assert.match(text, /3 configured — open one to edit, clone or delete/);
  assert.match(text, /Add a new provider…/);
  assert.match(text, /starts the connection wizard/);
  assert.match(text, /a add/, "the shortcut is offered");
  assert.match(text, /Esc close/);
  assert.doesNotMatch(text, /PROVIDERS/, "the list is its own page");
});

test("page one opens the list, and the list returns to page one", () => {
  const h = harness(base(), {}, "home");
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /PROVIDERS/);
  h.component.handleInput(escape);
  assert.match(plain(h.component.render(90)), /What would you like to do\?/);
  assert.equal(h.closed, 0, "going back a page is not closing");
});

test("page one starts the wizard directly", () => {
  const h = harness(base(), {}, "home");
  h.component.handleInput("a");
  assert.match(plain(h.component.render(90)), /Provider ID/);
  assert.equal(h.closed, 0);
});

test("page one adds a provider through its second option too", () => {
  const h = harness(base(), {}, "home");
  h.component.handleInput(down);
  h.component.handleInput(enter);
  assert.match(plain(h.component.render(90)), /Provider ID/, "the add row starts the same wizard as the shortcut");
});

// ── Clone ────────────────────────────────────────────────────────────────────

test("cloning offers the next provider_slug-n with a fresh, empty key", () => {
  const h = harness();
  h.component.handleInput(enter);   // open acme (account 1 of 2)
  h.component.handleInput("4");     // Clone with a new key…
  assert.match(plain(h.component.render(90)), /Display name/);
  assert.match(plain(h.component.render(90)), /Acme Cloud \(Account 3\)/);
  h.component.handleInput(escape);  // back to the id step, which is locked
  const idStep = plain(h.component.render(90));
  assert.match(idStep, /Provider ID \(locked\)/);
  assert.match(idStep, /acme-3/);
});

test("a clone saves as an account draft so the extension renames the family", () => {
  const h = harness();
  h.component.handleInput(enter);   // open acme
  h.component.handleInput("4");     // clone
  h.component.handleInput(escape);  // id step
  h.component.handleInput(escape);  // back to the list, values kept
  h.component.handleInput(enter);   // open acme again
  h.component.handleInput("4");     // clone again: the draft resumes
  // Name -> protocol -> URL -> key -> save, keeping the prefilled values.
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  h.component.handleInput(enter);
  type(h.component, "sk-second-account");
  h.component.handleInput(enter);
  const result = h.results[0];
  assert.equal(result?.kind, "save");
  if (result?.kind !== "save") return;
  assert.deepEqual(result.draft, {
    id: "acme-3",
    name: "Acme Cloud (Account 3)",
    api: "openai-completions",
    baseUrl: "https://api.acme.com/v1",
    apiKey: "sk-second-account",
    accountOf: "acme",
  });
});
