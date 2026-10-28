import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import artifactsExtension, {
  resolveEditorCommand, openArtifactInEditor,
  formatArtifactMarkdown,
  formatAge, artifactTypeIcon,
} from "../extensions/artifacts.ts";
import { MarkdownPopup, PopupPanel, PLAIN_THEME } from "../lib/popup.ts";
import { ARTIFACT_TYPE, type Artifact } from "../lib/artifact-state.ts";

function stripAnsi(text: string): string {
  return stripTerminalSequences(text);
}

function sampleArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "auth-spec",
    title: "Authentication Architecture Spec",
    type: "spec",
    content: "# Auth Spec\n\nOAuth2 with PKCE flow for secure mobile/web authentication.\n\n## Endpoints\n- POST /token",
    version: 2,
    createdBy: "agent-1",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T11:30:00.000Z",
    tags: ["auth", "security"],
    ...overrides,
  };
}

function harness() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const entries: any[] = [];
  const notifications: any[] = [];
  let customFactory: any;

  const pi: any = {
    on(name: string, fn: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
    },
    events: {
      on(name: string, fn: Function) {
        events.set(name, [...(events.get(name) ?? []), fn]);
      },
      async emit(name: string, payload: any) {
        for (const fn of events.get(name) ?? []) await fn(payload);
      },
    },
  };

  const context: any = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      addAutocompleteProvider(_f: any) {},
      setWidget(_name: string, _data: any) {},
      notify(...args: any[]) { notifications.push(args); },
      custom(factory: any) {
        customFactory = factory;
        return new Promise(() => {});
      },
    },
  };

  artifactsExtension(pi);

  async function emit(name: string, event: any = {}) {
    for (const fn of handlers.get(name) ?? []) {
      await fn(event, context);
    }
  }

  return { pi, context, emit, commands, entries, notifications, getCustomFactory: () => customFactory };
}

// ─────────────────────────────────────────────────────────────
// 1. Editor Command Resolution & Nvim Fallback Tests
// ─────────────────────────────────────────────────────────────

test("resolveEditorCommand prioritizes PI_EDITOR, then VISUAL, then EDITOR with arg splitting", () => {
  // PI_EDITOR overrides VISUAL and EDITOR
  const c1 = resolveEditorCommand({ PI_EDITOR: "code --wait", VISUAL: "nano", EDITOR: "vim" });
  assert.equal(c1.command, "code");
  assert.deepEqual(c1.args, ["--wait"]);

  // VISUAL overrides EDITOR
  const c2 = resolveEditorCommand({ VISUAL: "emacs -nw", EDITOR: "vim" });
  assert.equal(c2.command, "emacs");
  assert.deepEqual(c2.args, ["-nw"]);

  // EDITOR single binary
  const c3 = resolveEditorCommand({ EDITOR: "micro" });
  assert.equal(c3.command, "micro");
  assert.deepEqual(c3.args, []);

  // Degrades without any editor set: finds nvim if in PATH, else platform nano/notepad
  const emptyEnv = { PATH: "/nonexistent-empty-path" };
  const fallback = resolveEditorCommand(emptyEnv);
  assert.ok(fallback.command === "nano" || fallback.command === "notepad");
});

// ─────────────────────────────────────────────────────────────
// 2. openArtifactInEditor: Temp File, TUI Pause/Resume & Mock Spawn
// ─────────────────────────────────────────────────────────────

test("openArtifactInEditor creates temporary .md file, pauses/resumes TUI, and cleans up", async () => {
  let observedFile = "";
  let observedContent = "";
  let fileExistedDuringSpawn = false;
  let tuiEvents: string[] = [];

  const stubTui = {
    stop() { tuiEvents.push("stop"); },
    start() { tuiEvents.push("start"); },
    requestRender(_force?: boolean) { tuiEvents.push("render"); },
  };

  const mockSpawn = ((cmd: string, args: string[], _opts: any) => {
    observedFile = args[args.length - 1]!;
    fileExistedDuringSpawn = existsSync(observedFile);
    if (fileExistedDuringSpawn) {
      observedContent = readFileSync(observedFile, "utf8");
    }
    return {
      on(event: string, cb: Function) {
        if (event === "close") setTimeout(() => cb(0), 5);
      },
    };
  }) as any;

  const content = "# Sample Markdown\nTest artifact content.";
  const success = await openArtifactInEditor(content, {
    id: "spec-doc",
    title: "Spec Doc",
    tui: stubTui,
    spawnFn: mockSpawn,
    env: { PI_EDITOR: "mock-nvim" },
  });

  assert.equal(success, true);
  assert.ok(fileExistedDuringSpawn, "Temp file must exist while editor runs");
  assert.ok(observedFile.endsWith("spec-doc.md"), "Temp file must be named <id>.md for markdown detection");
  assert.equal(observedContent, content);
  assert.deepEqual(tuiEvents, ["stop", "start", "render"]);
  assert.equal(existsSync(observedFile), false, "Temp file must be cleaned up in finally");
});

test("openArtifactInEditor reports non-zero exit as failure without throwing and resumes TUI", async () => {
  let tuiEvents: string[] = [];
  const stubTui = {
    stop() { tuiEvents.push("stop"); },
    start() { tuiEvents.push("start"); },
    requestRender() { tuiEvents.push("render"); },
  };

  const failingSpawn = ((_cmd: string, _args: string[], _opts: any) => {
    return {
      on(event: string, cb: Function) {
        if (event === "close") setTimeout(() => cb(1), 5);
      },
    };
  }) as any;

  const success = await openArtifactInEditor("dummy content", {
    id: "fail-test",
    tui: stubTui,
    spawnFn: failingSpawn,
  });

  assert.equal(success, false, "Non-zero exit code must return false");
  assert.deepEqual(tuiEvents, ["stop", "start", "render"], "TUI must resume even on failure");
});

// ─────────────────────────────────────────────────────────────
// 3. Detail Popup Rendering, Width Limits & Markdown Header
// ─────────────────────────────────────────────────────────────

test("formatArtifactMarkdown starts with metadata header, separator, and artifact content", () => {
  const art = sampleArtifact();
  const md = formatArtifactMarkdown(art);

  assert.match(md, /^# \[auth-spec\] Authentication Architecture Spec/);
  assert.match(md, /- \*\*ID:\*\* `auth-spec`/);
  assert.match(md, /- \*\*Type:\*\* `spec`/);
  assert.match(md, /- \*\*Version:\*\* v2/);
  assert.match(md, /- \*\*Tags:\*\* auth, security/);
  assert.match(md, /- \*\*Created By:\*\* agent-1/);
  assert.match(md, /- \*\*Updated:\*\* 2026-10-20T11:30:00.000Z/);
  assert.match(md, /---\n\n# Auth Spec/);
});

test("detail popup renders within width w and includes frame, metadata, and separator", () => {
  const art = sampleArtifact();
  const md = formatArtifactMarkdown(art);

  for (const width of [60, 80, 100]) {
    const popup = new MarkdownPopup({
      markdown: md,
      theme: PLAIN_THEME,
      title: `[${art.id}] ${art.title}`,
      hint: "Esc close · o nvim",
      rows: 15,
    });

    const lines = popup.render(width);
    assert.ok(lines.length >= 6);

    // Top border contains ╭ and ╮ and title / hint
    const top = stripAnsi(lines[0]!);
    assert.ok(top.startsWith("╭"));
    assert.ok(top.endsWith("╮"));
    assert.match(top, /auth-spec/);
    assert.match(top, /o nvim/);

    // Bottom border contains ╰ and ╯
    const bottom = stripAnsi(lines[lines.length - 1]!);
    assert.ok(bottom.startsWith("╰"));
    assert.ok(bottom.endsWith("╯"));

    // Every line rendered must not exceed width w
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const clean = stripAnsi(line);
      const vw = visibleWidth(clean);
      assert.ok(vw <= width, `Line ${i} visibleWidth (${vw}) must be <= width (${width}): "${clean}"`);
    }

    // Body content rendered includes metadata and content
    const renderedText = lines.map(stripAnsi).join("\n");
    assert.match(renderedText, /ID:/);
    assert.match(renderedText, /Version:/);
  }
});

test("detail popup handles key o / v for external open and Esc / Enter for close", () => {
  let externalOpened = false;
  let closedWith: string | undefined;

  const popup = new MarkdownPopup({
    markdown: "# Heading\nBody text",
    theme: PLAIN_THEME,
    title: "Test",
    hint: "Esc close · o nvim",
    rows: 10,
    onClose: (action) => { closedWith = action; },
    onOpenExternal: () => {
      externalOpened = true;
      return true;
    },
  });

  // 'o' triggers external open
  popup.handleInput("o");
  assert.equal(externalOpened, true);
  assert.equal(closedWith, "external");

  // 'v' also triggers external open
  externalOpened = false;
  closedWith = undefined;
  popup.handleInput("v");
  assert.equal(externalOpened, true);
  assert.equal(closedWith, "external");

  // Esc closes
  closedWith = undefined;
  popup.handleInput("\x1b");
  assert.equal(closedWith, undefined);
});

// ─────────────────────────────────────────────────────────────
// 4. Framed Picker Popup: Navigation, Jump, Frame Borders & Width
// ─────────────────────────────────────────────────────────────

test("picker popup renders framed list with icons, sizes, and ages within width w", () => {
  const items = [
    sampleArtifact({ id: "plan-a", title: "Plan A", type: "plan" }),
    sampleArtifact({ id: "spec-b", title: "Spec B", type: "spec" }),
  ];

  let doneCalled = false;

  const theme = PLAIN_THEME;
  const panel = new PopupPanel({
    theme,
    title: `Workspace Artifacts (${items.length})`,
    hint: "Enter open · 1-9 jump · Esc close",
    onRender: (_width) => {
      const rows = items.map((art, idx) => {
        const marker = idx === 0 ? "→" : " ";
        const num = `${idx + 1}. `;
        const icon = artifactTypeIcon(art.type);
        const age = formatAge(art.updatedAt);
        return `${marker} ${num}${icon} [${art.id}] ${art.title}  v${art.version} · ${age}`;
      });
      panel.setContent(rows);
    },
    onKey: (key) => {
      if (key === "\x1b") doneCalled = true;
    },
  });

  for (const width of [60, 80]) {
    const lines = panel.render(width);
    assert.ok(lines.length >= 5);

    // Frame assertions
    const top = stripAnsi(lines[0]!);
    assert.ok(top.startsWith("╭"));
    assert.ok(top.endsWith("╮"));
    assert.match(top, /Workspace Artifacts/);
    assert.match(top, /1-9 jump/);

    const bottom = stripAnsi(lines[lines.length - 1]!);
    assert.ok(bottom.startsWith("╰"));
    assert.ok(bottom.endsWith("╯"));

    // Width assertion
    for (let i = 0; i < lines.length; i++) {
      const vw = visibleWidth(stripAnsi(lines[i]!));
      assert.ok(vw <= width, `Line ${i} visibleWidth (${vw}) must be <= width (${width})`);
    }
  }

  // Esc closes
  panel.handleInput("\x1b");
  assert.equal(doneCalled, true);
});

// ─────────────────────────────────────────────────────────────
// 5. Events: artifacts:open and artifacts:open-dialog
// ─────────────────────────────────────────────────────────────

test("artifacts:open event opens detail dialog for the specified artifact", async () => {
  const h = harness();
  const art = sampleArtifact();
  h.entries.push({ type: "custom", customType: ARTIFACT_TYPE, data: art });
  await h.emit("session_start");

  let renderedTitle = "";
  h.context.ui.custom = async (factory: any) => {
    const component = factory(
      { requestRender() {}, terminal: { rows: 24 } },
      PLAIN_THEME,
      {},
      () => {},
    );
    assert.ok(component instanceof MarkdownPopup);
    const lines = component.render(80);
    renderedTitle = stripAnsi(lines[0]!);
    return undefined;
  };

  await h.pi.events.emit("artifacts:open", { id: "auth-spec" });

  assert.match(renderedTitle, /auth-spec/);
  assert.match(renderedTitle, /Authentication Architecture Spec/);
});

test("artifacts:open-dialog event opens the framed picker popup", async () => {
  const h = harness();
  const art = sampleArtifact();
  h.entries.push({ type: "custom", customType: ARTIFACT_TYPE, data: art });
  await h.emit("session_start");

  let renderedTop = "";
  h.context.ui.custom = async (factory: any) => {
    const component = factory(
      { requestRender() {}, terminal: { rows: 24 } },
      PLAIN_THEME,
      {},
      () => {},
    );
    assert.ok(component instanceof PopupPanel);
    const lines = component.render(80);
    renderedTop = stripAnsi(lines[0]!);
    return undefined;
  };

  await h.pi.events.emit("artifacts:open-dialog", {});

  assert.match(renderedTop, /Workspace Artifacts/);
  assert.match(renderedTop, /1-9 jump/);
});

test("/artifacts command opens picker and navigating + Enter opens detail", async () => {
  const h = harness();
  const art1 = sampleArtifact({ id: "first-doc", title: "First Document" });
  const art2 = sampleArtifact({ id: "second-doc", title: "Second Document" });
  h.entries.push({ type: "custom", customType: ARTIFACT_TYPE, data: art1 });
  h.entries.push({ type: "custom", customType: ARTIFACT_TYPE, data: art2 });
  await h.emit("session_start");

  const openedComponents: any[] = [];
  h.context.ui.custom = async (factory: any) => {
    let resultValue: any;
    const component = factory(
      { requestRender() {}, terminal: { rows: 24 } },
      PLAIN_THEME,
      {},
      (val: any) => { resultValue = val; },
    );
    openedComponents.push(component);

    if (component instanceof PopupPanel) {
      if (openedComponents.length === 1) {
        // First time in picker: select second item and press Enter
        component.handleInput("j");
        component.handleInput("\r");
      } else {
        // Re-opened after detail closed: press Esc to close picker
        component.handleInput("\x1b");
      }
    } else if (component instanceof MarkdownPopup) {
      // Close detail
      component.handleInput("\x1b");
    }
    return resultValue;
  };

  const commandHandler = h.commands.get("artifacts").handler;
  await commandHandler("", h.context);

  assert.ok(openedComponents.length >= 2, "Picker followed by detail popup must have opened");
  assert.ok(openedComponents[0] instanceof PopupPanel, "First opened component is picker PopupPanel");
  assert.ok(openedComponents[1] instanceof MarkdownPopup, "Second opened component is detail MarkdownPopup");

  // Verify detail popup rendered content for second-doc
  const detailLines = openedComponents[1].render(80);
  const detailText = detailLines.map(stripAnsi).join("\n");
  assert.match(detailText, /second-doc/);
  assert.match(detailText, /Second Document/);
});
