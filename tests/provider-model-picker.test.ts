import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  ProviderModelPicker, providerModelPicker, type ModelChoice, type ModelSelection,
} from "../lib/provider-model-picker.ts";

const key = {
  up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~",
  enter: "\r", all: "\x01", manual: "\x07", escape: "\x1b", cancel: "\x03",
};
const models: readonly ModelChoice[] = [
  { id: "alpha/Reasoner", name: "Deep Thinking" },
  { id: "beta-chat", name: "Fast Chat" },
  { id: "gamma-chat", name: "Deep Chat" },
  { id: "unnamed" },
];
const manyModels = Array.from({ length: 50 }, (_, i) => ({ id: `model-${String(i).padStart(2, "0")}` }));

function fixture(choices: readonly ModelChoice[] = models, initialRows = 24) {
  const results: ModelSelection[] = [];
  let renders = 0;
  let rows = initialRows;
  const component = new ProviderModelPicker(choices, result => results.push(result), () => renders++, () => rows);
  return { component, results, renders: () => renders, resize: (value: number) => { rows = value; } };
}

function paste(component: ProviderModelPicker, text: string) {
  component.handleInput(`\x1b[200~${text}\x1b[201~`);
}
function search(component: ProviderModelPicker, text: string) {
  component.handleInput("\x05"); // End, then kill the entire query (Ctrl+A toggles matches).
  component.handleInput("\x15");
  if (text) paste(component, text);
}
function lines(component: ProviderModelPicker, width = 120) {
  return component.render(width).map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
}
function items(component: ProviderModelPicker) {
  // The picker now renders inside the shared popup frame, so rows carry its
  // side padding; match the row vocabulary rather than the line start.
  return lines(component).filter(line => /(?:→ |  )\[[ x]\] /.test(line));
}
function ids(component: ProviderModelPicker) {
  return items(component).map(line => line.match(/\[[ x]\] (\S+)/)![1]);
}
function highlighted(component: ProviderModelPicker) {
  return items(component).find(line => line.includes("→ ["))?.match(/→ \[[ x]\] (\S+)/)?.[1];
}
function count(component: ProviderModelPicker, selected: number, matching: number, total = models.length) {
  assert.ok(lines(component).some(line => line.includes(`${selected} selected · ${matching}/${total} matching`)));
}

test("search matches ID and optional display name case-insensitively with all whitespace-separated terms", () => {
  const { component, results } = fixture();
  for (const [query, expected] of [
    ["ALPHA/reas", ["alpha/Reasoner"]],
    ["tHiNkInG", ["alpha/Reasoner"]],
    ["  CHAT   dEeP  ", ["gamma-chat"]],
    ["alpha THINK", ["alpha/Reasoner"]],
    ["UNNAMED", ["unnamed"]],
    [" \t ", models.map(model => model.id)],
    ["absent", []],
  ] as [string, string[]][]) {
    search(component, query);
    assert.deepEqual(ids(component), expected, query);
    count(component, 0, expected.length);
  }
  assert.deepEqual(results, []);
});

test("changing search resets the highlight and clearing search restores all choices", () => {
  const { component } = fixture();
  component.handleInput(key.down);
  component.handleInput(key.down);
  assert.equal(highlighted(component), "gamma-chat");
  search(component, "chat");
  assert.equal(highlighted(component), "beta-chat");
  search(component, "");
  assert.equal(highlighted(component), "alpha/Reasoner");
  assert.deepEqual(ids(component), models.map(model => model.id));
});

test("large lists render a bounded scrolling viewport and arrow navigation reaches every model", () => {
  const { component } = fixture(manyModels);
  const visible = items(component).length;
  assert.ok(visible < manyModels.length, "the viewport is bounded, not the whole catalog");
  assert.ok(visible >= 3);
  assert.match(lines(component).join("\n"), /1\/50/, "the footer carries the position");
  for (let i = 0; i < manyModels.length; i++) {
    assert.equal(highlighted(component), manyModels[i].id);
    assert.equal(items(component).length, visible, "the viewport size is stable while moving");
    assert.ok(component.render(120).length <= 24);
    if (i < manyModels.length - 1) component.handleInput(key.down);
  }
  assert.ok(!ids(component).includes("model-00"), "viewport scrolls instead of rendering the full list");
  assert.match(lines(component).join("\n"), /50\/50/);
  component.handleInput(key.up);
  assert.equal(highlighted(component), "model-48");
});

test("page navigation moves by the visible row count and does not edit the search", () => {
  const { component, results } = fixture(manyModels, 14);
  search(component, "MODEL");
  const visible = items(component).length;
  assert.ok(visible >= 2 && visible < manyModels.length);
  component.handleInput(key.pageDown);
  assert.equal(highlighted(component), manyModels[visible]!.id);
  component.handleInput(key.pageDown);
  assert.equal(highlighted(component), manyModels[visible * 2]!.id);
  component.handleInput(key.pageUp);
  assert.equal(highlighted(component), manyModels[visible]!.id);
  assert.ok(lines(component).some(line => line.includes("Search: MODEL")));
  assert.deepEqual(results, []);
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: [manyModels[visible]!.id] }]);
});

test("arrow boundary navigation wraps within the bounded viewport", () => {
  const { component } = fixture(manyModels, 12);
  const visible = items(component).length;
  component.handleInput(key.up);
  assert.equal(highlighted(component), "model-49");
  assert.equal(items(component).length, visible);
  component.handleInput(key.down);
  assert.equal(highlighted(component), "model-00");
});

test("Space toggles only the highlighted model and preserves highlight and query", () => {
  const { component, results } = fixture();
  search(component, "chat");
  component.handleInput(key.down);
  component.handleInput(" ");
  assert.equal(highlighted(component), "gamma-chat");
  assert.match(items(component)[1], /→ \[x\] gamma-chat/);
  count(component, 1, 2);
  assert.ok(lines(component).some(line => line.includes("Search: chat")));
  component.handleInput(" ");
  count(component, 0, 2);
  assert.match(items(component)[1], /→ \[ \] gamma-chat/);
  assert.deepEqual(results, []);
});

test("selections persist across searches and confirmation returns model order, not selection order", () => {
  const { component, results } = fixture();
  search(component, "gamma");
  component.handleInput(" ");
  search(component, "alpha");
  count(component, 1, 1);
  component.handleInput(" ");
  search(component, "");
  assert.match(items(component)[0], /\[x\] alpha\/Reasoner/);
  assert.match(items(component)[2], /\[x\] gamma-chat/);
  count(component, 2, 4);
  component.handleInput(key.down); // Highlight an unselected model; Enter must not add it.
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: ["alpha/Reasoner", "gamma-chat"] }]);
});

test("Ctrl+A toggles all filtered models without disturbing hidden selections", () => {
  const { component, results } = fixture();
  component.handleInput(" "); // Hidden alpha selection.
  search(component, "chat");
  component.handleInput(" "); // A partial filtered selection.
  component.handleInput(key.all); // Complete, rather than invert, the filtered selection.
  assert.ok(items(component).every(line => line.includes("[x]")));
  count(component, 3, 2);
  component.handleInput(key.all);
  assert.ok(items(component).every(line => line.includes("[ ]")));
  count(component, 1, 2);
  search(component, "alpha");
  assert.match(items(component)[0], /\[x\] alpha\/Reasoner/);
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: ["alpha/Reasoner"] }]);
});

test("Ctrl+A with an empty query selects and deselects the entire catalog", () => {
  const { component } = fixture(manyModels);
  component.handleInput(key.all);
  count(component, 50, 50, 50);
  search(component, "model-49");
  assert.match(items(component)[0], /\[x\] model-49/);
  search(component, "");
  component.handleInput(key.all);
  count(component, 0, 50, 50);
});

test("zero matches: Enter, Space and Ctrl+A do not finish or select anything", () => {
  const { component, results } = fixture();
  search(component, "not-a-model");
  assert.ok(lines(component).some(line => line.includes("No matching models")));
  for (const input of [key.enter, " ", key.all, key.up, key.down, key.pageUp, key.pageDown, key.enter]) {
    component.handleInput(input);
    count(component, 0, 0);
    assert.deepEqual(results, []);
  }
  search(component, "beta");
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: ["beta-chat"] }]);
});

test("zero matches still allows confirming existing hidden selections, even after toggle-all", () => {
  const { component, results } = fixture();
  component.handleInput(" ");
  search(component, "not-a-model");
  component.handleInput(key.all);
  component.handleInput(" ");
  count(component, 1, 0);
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: ["alpha/Reasoner"] }]);
});

test("an empty catalog stays open on Enter and offers manual entry", () => {
  const { component, results } = fixture([]);
  count(component, 0, 0, 0);
  component.handleInput(key.enter);
  assert.deepEqual(results, []);
  component.handleInput(key.manual);
  assert.deepEqual(results, [{ manual: true }]);
});

for (const [name, input, expected] of [
  ["Ctrl+G manual entry", key.manual, { manual: true }],
  ["Escape cancellation", key.escape, undefined],
  ["Ctrl+C cancellation", key.cancel, undefined],
] as const) {
  test(`${name} completes exactly once, ignoring subsequent input and render requests`, () => {
    const h = fixture();
    h.component.handleInput(" ");
    search(h.component, "absent");
    h.component.handleInput(input);
    assert.deepEqual(h.results, [expected]);
    const renders = h.renders();
    const before = h.component.render(120);
    for (const extra of [key.enter, key.manual, key.escape, key.cancel, " ", key.all, "text"]) {
      h.component.handleInput(extra);
    }
    assert.deepEqual(h.results, [expected]);
    assert.equal(h.renders(), renders);
    assert.deepEqual(h.component.render(120), before);
  });
}

test("Enter confirms the highlighted model once when no explicit selection exists", () => {
  const h = fixture();
  h.component.handleInput(key.down);
  h.component.handleInput(key.enter);
  h.component.handleInput(key.enter);
  h.component.handleInput(key.cancel);
  assert.deepEqual(h.results, [{ ids: ["beta-chat"] }]);
  assert.equal(h.renders(), 2);
});

test("focus forwards to Input and renders exactly one cursor marker only when focused", () => {
  const { component } = fixture();
  assert.equal(component.focused, false);
  assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
  component.focused = true;
  paste(component, "alpha");
  assert.ok(lines(component).some(line => line.includes("Search: alpha")), "the search text is visible");
  const markers = () => component.render(80).join("\n").split(CURSOR_MARKER).length - 1;
  assert.equal(markers(), 1, "the Input paints exactly one cursor marker, not a reimplementation");
  component.handleInput("\x1b[D");
  component.invalidate();
  assert.equal(markers(), 1, "editing keeps exactly one cursor");
  component.focused = false;
  assert.equal(component.focused, false);
  assert.equal(markers(), 0, "an unfocused picker paints no cursor");
});

test("Unicode IDs, descriptions and search fit narrow and fractional terminal widths", () => {
  const choices = [
    { id: "模型-🔑-e\u0301", name: "宽显示名称 👩‍💻 modèle" },
    { id: "日本語-model", name: "Long display name ".repeat(20) },
  ];
  const { component } = fixture(choices);
  for (const focused of [false, true]) {
    component.focused = focused;
    for (const query of ["", "模型", "不存在".repeat(20)]) {
      search(component, query);
      for (const width of [0, 1, 2, 3, 4, 5, 7, 8, 12, 20, 40, 41, 80, 120, 4.9]) {
        const rendered = component.render(width);
        assert.ok(rendered.length > 0);
        for (const line of rendered) {
          assert.ok(visibleWidth(line) <= Math.floor(width), `width ${width}: ${JSON.stringify(line)}`);
          assert.ok(!/[\r\n]/.test(line));
        }
        if (width < 4) assert.deepEqual(rendered, [""]);
      }
    }
  }
  search(component, "MODÈLE");
  assert.deepEqual(ids(component), ["模型-🔑-e\u0301"]);
});

test("the wheel moves the highlight and a click toggles exactly that row without submitting", () => {
  const { component, results } = fixture(manyModels);
  const event = (type: TuiMouseEvent["type"], y: number): TuiMouseEvent => ({
    type, y, x: 5, screenX: 5, screenY: y, width: 120, height: 24,
    button: type === "wheel" ? "none" : "left", wheelDelta: type === "wheel" ? 1 : undefined,
    shift: false, alt: false, ctrl: false,
  });
  const top = lines(component).findIndex(line => line.includes("→ ["));
  assert.ok(top > 0, "the first model row sits below the frame and header");
  assert.equal(component.handleMouse(event("wheel", top))?.handled, true);
  assert.equal(highlighted(component), "model-01", "the wheel moves the highlight");
  const target = top + 2;
  assert.equal(component.handleMouse(event("press", target))?.handled, true);
  assert.equal(highlighted(component), "model-02");
  assert.equal(component.handleMouse(event("click", target))?.render, true);
  count(component, 1, 50, 50);
  assert.deepEqual(results, [], "a click toggles, it does not submit");
  assert.equal(component.handleMouse(event("click", 1)), undefined, "the chrome is not a row");
  assert.equal(component.handleMouse(event("click", 20)), undefined, "outside the viewport is not a row");
  count(component, 1, 50, 50);
  component.handleInput(key.enter);
  assert.deepEqual(results, [{ ids: ["model-02"] }]);
  assert.equal(component.handleMouse(event("click", target)), undefined, "a closed picker ignores the mouse");
});

test("terminal height changes resize the bounded viewport while retaining highlight and selection", () => {
  const h = fixture(manyModels);
  h.component.handleInput(key.pageDown);
  h.component.handleInput(key.pageDown);
  const marked = highlighted(h.component)!;
  assert.match(marked, /^model-\d+$/, "paging moved the highlight into the catalog");
  h.component.handleInput(" ");
  for (const [rows] of [[14], [9], [8], [7], [6], [4], [3], [2], [1], [40], [24]]) {
    h.resize(rows);
    const text = lines(h.component).join("\n");
    assert.equal(highlighted(h.component), marked, `the highlight survives a ${rows}-row resize`);
    assert.match(items(h.component).find(line => line.includes("→ "))!, /\[x\]/, "the selection survives the resize");
    // Below ten rows the frame leaves three content rows, so the count yields to
    // keep a model visible; the position stays in the title row either way.
    if (rows >= 10 || (rows >= 5 && rows < 8)) count(h.component, 1, 50, 50);
    if (rows >= 3) assert.match(text, /\d+\/50/, "the position is visible whenever a hint row fits");
    assert.ok(h.component.render(120).length <= Math.max(1, rows), `picker must fit even a ${rows}-row viewport`);
    if (rows >= 2) assert.match(text, /Search:/);
    if (rows >= 3) assert.match(text, /Enter/);
  }
  h.resize(13);
  h.component.render(120); // Render applies terminal resize before navigation.
  const index = manyModels.findIndex(model => model.id === marked);
  const visible = items(h.component).length;
  h.component.handleInput(key.pageDown);
  assert.equal(highlighted(h.component), manyModels[(index + visible) % manyModels.length]!.id,
    "paging is one viewport, whatever the height");
  h.component.handleInput(key.pageUp);
  assert.equal(highlighted(h.component), marked);
});

// Fail on any UI method other than the permitted surface, including custom() in RPC.
function context(mode: string, method: "custom" | "select", implementation: unknown) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "mode") return mode;
      assert.equal(property, "ui", "no session or persistence access");
      return new Proxy({}, {
        get(_ui, name) {
          assert.equal(name, method, `only ui.${method} is permitted`);
          return implementation;
        },
      });
    },
  }) as ExtensionCommandContext;
}

test("TUI helper constructs the custom picker with terminal height, theme and render callback", async () => {
  let calls = 0;
  let renders = 0;
  let rows = 13;
  const colors: string[] = [];
  type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
  const ctx = context("tui", "custom", (factory: Factory, options: unknown) => new Promise(resolve => {
    assert.deepEqual(options, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "100%", margin: 0 },
    });
    calls++;
    const tui = { requestRender: () => renders++, terminal: { get rows() { return rows; } } } as unknown as Parameters<Factory>[0];
    const theme = {
      fg: (color: string, text: string) => { colors.push(color); return text; },
      bold: (text: string) => text,
    } as Parameters<Factory>[1];
    const component = factory(tui, theme, {} as Parameters<Factory>[2], resolve);
    assert.ok(component instanceof ProviderModelPicker);
    const at13 = items(component).length;
    assert.ok(at13 > 1, "a 13-row terminal shows several models");
    assert.ok(colors.includes("accent"));
    assert.ok(colors.includes("dim"));
    rows = 10;
    assert.ok(items(component).length < at13, "a shorter terminal shows fewer rows");
    component.handleInput(key.down);
    component.handleInput(key.enter);
  }));
  assert.deepEqual(await providerModelPicker(ctx, manyModels), { ids: ["model-01"] });
  assert.equal(calls, 1);
  assert.equal(renders, 2);
});

type Dialog = { title: string; options: string[] };
function rpcFixture(replies: ((dialog: Dialog) => string | undefined)[]) {
  const dialogs: Dialog[] = [];
  const ctx = context("rpc", "select", async (title: string, options: string[]) => {
    const index = dialogs.length;
    const dialog = { title, options: [...options] };
    dialogs.push(dialog);
    assert.ok(index < replies.length, "RPC loop must not request unexpected dialogs");
    assert.equal(title, "Select models to add/update");
    assert.equal(options.at(-1), "Enter model ID manually");
    return replies[index](dialog);
  });
  return { ctx, dialogs };
}

test("RPC fallback supports repeated multi-select, deselection, counts and catalog-order results without custom UI", async () => {
  const h = rpcFixture([
    ({ options }) => {
      assert.deepEqual(options, [
        "[ ] Model: alpha/Reasoner", "[ ] Model: beta-chat", "[ ] Model: gamma-chat", "[ ] Model: unnamed",
        "Enter model ID manually",
      ]);
      return options[2];
    },
    ({ options }) => {
      assert.equal(options[2], "[x] Model: gamma-chat");
      assert.equal(options.at(-2), "Use selected models (1)");
      return options[0];
    },
    ({ options }) => {
      assert.equal(options[0], "[x] Model: alpha/Reasoner");
      assert.equal(options.at(-2), "Use selected models (2)");
      return options[2]; // Remove gamma.
    },
    ({ options }) => {
      assert.equal(options[2], "[ ] Model: gamma-chat");
      assert.equal(options.at(-2), "Use selected models (1)");
      return options[2]; // Select gamma again.
    },
    ({ options }) => options.at(-2),
  ]);
  assert.deepEqual(await providerModelPicker(h.ctx, models), { ids: ["alpha/Reasoner", "gamma-chat"] });
  assert.equal(h.dialogs.length, 5);
});

test("RPC deselecting the last model removes the finish option", async () => {
  const h = rpcFixture([
    ({ options }) => options[0],
    ({ options }) => options[0],
    ({ options }) => {
      assert.ok(!options.some(option => option.startsWith("Use selected models")));
      assert.equal(options[0], "[ ] Model: alpha/Reasoner");
      return undefined;
    },
  ]);
  assert.equal(await providerModelPicker(h.ctx, models), undefined);
  assert.equal(h.dialogs.length, 3);
});

test("RPC manual entry and cancellation discard pending selections and never invoke custom UI", async () => {
  for (const pending of [false, true]) {
    for (const manual of [false, true]) {
      const replies: ((dialog: Dialog) => string | undefined)[] = [];
      if (pending) replies.push(({ options }) => options[0]);
      replies.push(({ options }) => manual ? options.at(-1) : undefined);
      const h = rpcFixture(replies);
      assert.deepEqual(await providerModelPicker(h.ctx, models), manual ? { manual: true } : undefined);
      assert.equal(h.dialogs.length, pending ? 2 : 1);
    }
  }
});

test("RPC empty catalogs offer only manual entry and still support cancellation", async () => {
  for (const manual of [false, true]) {
    const h = rpcFixture([({ options }) => {
      assert.deepEqual(options, ["Enter model ID manually"]);
      return manual ? options[0] : undefined;
    }]);
    assert.deepEqual(await providerModelPicker(h.ctx, []), manual ? { manual: true } : undefined);
    assert.equal(h.dialogs.length, 1);
  }
});

test("RPC rejects unknown dialog responses rather than silently saving a selection", async () => {
  const h = rpcFixture([() => "unknown-model"]);
  await assert.rejects(providerModelPicker(h.ctx, models), /Invalid model selection; nothing was saved\./);
  assert.equal(h.dialogs.length, 1);
});
