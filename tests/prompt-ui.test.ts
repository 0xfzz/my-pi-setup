import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import promptUi, {
  ContextFooter,
  collectUsage,
  contextBar,
  contextColor,
  formatCwd,
  formatTokens,
  modelLabel,
  renderModelTopBorder,
} from "../lib/popup/prompt-ui.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const footerData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => new Map([["mcp", "MCP: 1 server enabled"]]),
  getAvailableProviderCount: () => 1,
  onBranchChange: () => () => {},
} as any;

function fakeContext(overrides: Record<string, unknown> = {}) {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 500, cost: 0.12 } } },
    { type: "usage", usage: { input: 500, output: 100, cacheRead: 1000, cacheWrite: 0, cost: 0.03 } },
  ];
  return {
    mode: "tui",
    model: { id: "deepseek-v4.1-flash", provider: "opencode-go", contextWindow: 1_000_000, reasoning: true },
    thinkingLevel: "high",
    getContextUsage: () => ({ tokens: 275_000, contextWindow: 1_000_000, percent: 27.5 }),
    sessionManager: {
      getCwd: () => process.cwd(),
      getSessionName: () => "Popup design system",
      getEntries: () => entries,
      getLeafId: () => "leaf-1",
      getSessionFile: () => undefined,
    },
    ui: { setWidget() {}, setFooter() {} },
    ...overrides,
  } as any;
}

test("formatTokens matches the footer vocabulary", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(15_000), "15k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(27_000_000), "27M");
});

test("contextBar renders an exact-width progress bar", () => {
  assert.equal(contextBar(50, 10), "█████░░░░░");
  assert.equal(contextBar(0, 4), "░░░░");
  assert.equal(contextBar(100, 4), "████");
  assert.equal(contextBar(null, 4), "░░░░");
  assert.equal(visibleWidth(contextBar(27.5, 16)), 16);
});

test("contextColor escalates before the window is exhausted", () => {
  assert.equal(contextColor(null), "dim");
  assert.equal(contextColor(27.5), "success");
  assert.equal(contextColor(75), "warning");
  assert.equal(contextColor(95), "error");
});

test("formatCwd collapses the home prefix", () => {
  assert.equal(formatCwd("/home/faiz/projects/app", "/home/faiz"), "~/projects/app");
  assert.equal(formatCwd("/home/faiz", "/home/faiz"), "~");
  assert.equal(formatCwd("/var/tmp", "/home/faiz"), "/var/tmp");
});

test("collectUsage sums message, usage, and cache hit rate", () => {
  const totals = collectUsage([
    { type: "message", message: { role: "assistant", usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 500, cost: 0.12 } } },
    { type: "usage", usage: { input: 500, output: 100, cacheRead: 1000, cacheWrite: 0, cost: 0.03 } },
    { type: "compaction", usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
  ]);
  assert.equal(totals.input, 1600);
  assert.equal(totals.output, 300);
  assert.equal(totals.cacheRead, 5000);
  assert.equal(totals.cacheWrite, 500);
  assert.equal(totals.cost, 0.16);
  // Last assistant prompt is 1000 + 4000 + 500 = 5500; cacheRead 4000 = 72.7%.
  assert.equal(totals.cacheHitRate?.toFixed(1), "72.7");
});

test("modelLabel joins model, provider and thinking variant", () => {
  const ctx = fakeContext();
  assert.equal(modelLabel(ctx), "deepseek-v4.1-flash · opencode-go · high");
  assert.equal(modelLabel(undefined), undefined);
});

test("renderModelTopBorder embeds the model in the editor top rule", () => {
  const border = (text: string) => text;
  const line = renderModelTopBorder("deepseek-v4.1-flash · opencode-go · high", 60, border);
  assert.ok(line.startsWith("── deepseek-v4.1-flash"), line);
  assert.match(line, /high/);
  assert.equal(visibleWidth(line), 60);

  const narrow = renderModelTopBorder("a-very-long-model-name · provider · high", 20, border);
  assert.ok(visibleWidth(narrow) <= 20, narrow);
  assert.match(narrow, /…/);

  const scrolled = renderModelTopBorder("deepseek", 40, border, 3);
  assert.match(scrolled, /↑3/);
});

test("ContextFooter stays compact while explaining context and cost", () => {
  const ctx = fakeContext();
  const footer = new ContextFooter(() => ctx, theme, footerData);
  const lines = footer.render(100).map(stripTerminalSequences);
  const text = lines.join("\n");
  assert.match(text, /~/);
  assert.match(text, /\(main\)/);
  assert.match(text, /Popup design system/);
  assert.match(text, /ctx/i);
  assert.match(text, /27\.5%/);
  assert.match(text, /275k\/1\.0M/);
  assert.match(text, /725k left/);
  assert.match(text, /█/);
  assert.match(text, /↑1\.5k/);
  assert.match(text, /↓300/);
  assert.match(text, /\$0\.150/);
  assert.match(text, /MCP: 1 server enabled/);
  // Cache counters moved out of the minimal footer; cost and context stay.
  assert.doesNotMatch(text, /R5\.0k|CH72\.7%/);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 100, `line exceeds width: ${line}`);
  }
});

test("ContextFooter handles an unknown context and narrow terminals", () => {
  const ctx = fakeContext({
    getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000, percent: null }),
  });
  const footer = new ContextFooter(() => ctx, theme, footerData);
  const lines = footer.render(30).map(stripTerminalSequences);
  assert.match(lines.join("\n"), /\?/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 30);
});

test("promptUi installs the model border editor and clears it on shutdown", () => {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, fn: Function) => handlers.set(name, fn) } as any;
  promptUi(pi);
  const calls: Array<{ kind: string; key?: string }> = [];
  const ctx = fakeContext();
  ctx.ui = {
    setEditorComponent(content: unknown) {
      calls.push({ kind: "editor", key: content === undefined ? "cleared" : "set" });
    },
    setFooter(content: unknown) {
      calls.push({ kind: "footer", key: content === undefined ? "cleared" : "set" });
    },
  };

  handlers.get("session_start")!({}, ctx);
  assert.deepEqual(calls, [
    { kind: "editor", key: "set" },
    { kind: "footer", key: "set" },
  ]);

  handlers.get("session_shutdown")!();
  assert.deepEqual(calls.slice(-2), [
    { kind: "editor", key: "cleared" },
    { kind: "footer", key: "cleared" },
  ]);
});

test("promptUi composes the model border over the editor already in the slot", async () => {
  const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
  const handlers = new Map<string, Function>();
  promptUi({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);

  // Stand-in for pi-paster / modes: claims the slot before prompt-ui loads.
  class PasterEditor extends CustomEditor { pasterFeature = true; }
  let slot: any = (tui: any, editorTheme: any, keybindings: any) => new PasterEditor(tui, editorTheme, keybindings);
  const ctx = fakeContext();
  ctx.ui = {
    getEditorComponent: () => slot,
    setEditorComponent(content: any) { slot = content; },
    setFooter() {},
  };

  handlers.get("session_start")!({}, ctx);
  // Reload must not stack a second wrapper on top of the first.
  handlers.get("session_start")!({}, ctx);

  const color = (text: string) => text;
  const editorTheme = { borderColor: color, selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color } };
  const editor: any = slot({ requestRender() {}, terminal: { rows: 30, columns: 80 } }, editorTheme, { matches: () => false });

  assert.equal(editor.pasterFeature, true, "the previous owner's editor must survive");
  const top = stripTerminalSequences(editor.render(80)[0]!);
  assert.match(top, /deepseek-v4\.1-flash · opencode-go · high/);
  assert.equal(top.split("deepseek-v4.1-flash").length - 1, 1, "the label is drawn once, not per reload");
  assert.ok(visibleWidth(top) <= 80);
});
