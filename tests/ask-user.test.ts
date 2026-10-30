import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Use Pi's existing loader/dependencies; no package installation is necessary.
// Run: node --experimental-strip-types --test tests/ask-user.test.ts
const install = join(homedir(), ".pi/agent/install");
const piRoot = process.env.PI_PACKAGE_DIR || join(
  install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(),
  "node_modules/@earendil-works/pi-coding-agent",
);
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url, { alias: { typebox: piRequire.resolve("typebox") } });
const extension = (await jiti.import("../extensions/ask-user.ts")).default;

function setup() {
  const tools: any[] = [];
  const hooks: Record<string, Function> = {};
  extension({
    registerTool: (tool: any) => tools.push(tool),
    on: (event: string, handler: Function) => { hooks[event] = handler; },
  });
  assert.equal(tools.length, 1);
  const calls: any[] = [];
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    // Child identity is proven against this process's own session file, so a
    // faithful stub reports the file the environment names — exactly what a real
    // Herdr child has, since it is launched with `--session <that file>`.
    sessionManager: { getSessionFile: () => process.env.PI_SUBAGENT_SESSION },
    tools: [{ name: "agent_ping" }],
    ui: {
      input: async (...args: any[]) => { calls.push(["input", ...args]); return "answer"; },
      select: async (...args: any[]) => { calls.push(["select", ...args]); return "no"; },
    },
    executeTool: async (...args: any[]) => {
      calls.push(["nested", ...args]);
      return { isError: false, result: { content: [], details: {} } };
    },
  };
  return { tool: tools[0], hooks, ctx, calls,
    run: (params: any = { question: "Proceed?" }, signal?: AbortSignal) =>
      tools[0].execute("test", params, signal, undefined, ctx),
  };
}

// Environment is restored after every test; no child/session/branch state is held by the extension.
async function withSession(child: boolean, body: () => Promise<void>) {
  const old = process.env.PI_SUBAGENT_SESSION;
  if (child) process.env.PI_SUBAGENT_SESSION = "/tmp/example-child.jsonl";
  else delete process.env.PI_SUBAGENT_SESSION;
  try { await body(); } finally {
    if (old === undefined) delete process.env.PI_SUBAGENT_SESSION;
    else process.env.PI_SUBAGENT_SESSION = old;
  }
}

function status(output: any, expected: string) {
  assert.equal(output.details.status, expected);
  assert.deepEqual(JSON.parse(output.content[0].text), output.details);
  if (expected !== "answered") assert.equal(output.details.answer, undefined);
}

test("model-only sequential tool, schema and nested-tool declaration", () => {
  const { tool } = setup();
  assert.equal(tool.name, "ask_user");
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(tool.reachesTools({}), ["agent_ping"]);
  assert.deepEqual(tool.parameters.required, ["question"]);
  assert.equal(tool.parameters.properties.options.minItems, 1);
  assert.equal(tool.parameters.properties.options.uniqueItems, true);
  assert.equal(tool.parameters.properties.recommended.minimum, 1);
});

test("invalid recommended option is unavailable before any UI is opened", () => withSession(false, async () => {
  const { run, calls } = setup();
  const out = await run({ question: "Pick", options: ["a"], recommended: 2 } as any);
  status(out, "unavailable");
  assert.match(out.details.message, /1-based option number/);
  assert.deepEqual(calls, []);
}));

test("TUI custom popup resolves the recommended choice through AskUserPopup", () => withSession(false, async () => {
  const { run, ctx } = setup();
  ctx.ui.custom = async (factory: any) => {
    let result: string | undefined;
    const done = (value: string | undefined) => { result = value; };
    const component = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_token: string, text: string) => text, bold: (text: string) => text },
      {},
      done,
    );
    component.focused = true;
    component.handleInput("\r");
    return result;
  };
  const out = await run({ question: "Pick", options: ["a", "b"], recommended: 2 } as any);
  status(out, "answered");
  assert.equal(out.details.answer, "a");
}));

test("custom typed answer is accepted when options are provided in custom popup", () => withSession(false, async () => {
  const { run, ctx } = setup();
  ctx.ui.custom = async (factory: any) => {
    let result: any;
    const done = (value: any) => { result = value; };
    const component = factory(
      { terminal: { rows: 24 }, requestRender() {} },
      { fg: (_token: string, text: string) => text, bold: (text: string) => text },
      {},
      done,
    );
    component.focused = true;
    // Down to "Type your own answer..."
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    for (const char of "custom choice") component.handleInput(char);
    component.handleInput("\r");
    return result;
  };
  const out = await run({ question: "Pick", options: ["a", "b"] } as any);
  status(out, "answered");
  assert.equal(out.details.answer, "custom choice");
  assert.equal(out.details.answeredWith, "text");
}));

test("free-text answer includes context and passes cancellation options", () => withSession(false, async () => {
  const { run, calls } = setup();
  const signal = new AbortController().signal;
  const out = await run({ question: "Which region?", context: "Deployment target" }, signal);
  status(out, "answered");
  assert.equal(out.details.answer, "answer");
  assert.deepEqual(calls, [["input", "Which region?\n\nDeployment target", undefined, { signal }]]);
}));

test("RPC uses supported built-in selection, preserves an explicit negative answer", () => withSession(false, async () => {
  const { run, ctx, calls } = setup();
  ctx.mode = "rpc";
  const signal = new AbortController().signal;
  const out = await run({ question: "Proceed?", options: ["yes", "no"] }, signal);
  status(out, "answered");
  assert.equal(out.details.answer, "no");
  assert.deepEqual(calls, [["select", "Proceed?", ["yes", "no"], { signal }]]);
}));

test("dismissal and empty input are unanswered, never consent", () => withSession(false, async () => {
  for (const value of [undefined, "", "   "]) {
    const { run, ctx } = setup();
    ctx.ui.input = async () => value;
    const out = await run();
    status(out, "cancelled");
    assert.match(out.details.message, /No consent/);
  }
  const { run, ctx } = setup();
  ctx.ui.select = async () => undefined;
  status(await run({ question: "Proceed?", options: ["yes", "no"] }), "cancelled");
}));

test("pre-aborted calls perform no UI or forwarding, in parent or child", async () => {
  for (const child of [false, true]) await withSession(child, async () => {
    const { run, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    status(await run(undefined, controller.signal), "cancelled");
    assert.deepEqual(calls, []);
  });
});

test("abort during UI cannot become an answer", () => withSession(false, async () => {
  const { run, ctx } = setup();
  const controller = new AbortController();
  ctx.ui.input = async (_title: string, _placeholder: any, opts: any) => {
    assert.equal(opts.signal, controller.signal);
    controller.abort();
    return "yes";
  };
  status(await run(undefined, controller.signal), "cancelled");
}));

test("abort rejection is cancelled, ordinary dialog failure is actionable unavailable", () => withSession(false, async () => {
  const { run, ctx } = setup();
  const controller = new AbortController();
  ctx.ui.input = async () => { controller.abort(); throw new Error("aborted"); };
  status(await run(undefined, controller.signal), "cancelled");
  ctx.ui.input = async () => { throw new Error("RPC disconnected"); };
  const out = await run();
  status(out, "unavailable");
  assert.equal(out.isError, true);
  assert.match(out.details.message, /RPC disconnected/);
}));

test("no UI and invalid selection fail explicitly without guessing", () => withSession(false, async () => {
  const { run, ctx, calls } = setup();
  ctx.hasUI = false;
  status(await run(), "unavailable");
  assert.deepEqual(calls, []);
  ctx.hasUI = true;
  ctx.ui.select = async () => "not an option";
  status(await run({ question: "Proceed?", options: ["yes", "no"] }), "unavailable");
  status(await run({ question: "   " }), "unavailable");
}));

test("child forwards full question through agent_ping with signal, never direct UI", () => withSession(true, async () => {
  const { run, ctx, calls } = setup();
  ctx.hasUI = true; // Child isolation must not depend on this flag.
  const signal = new AbortController().signal;
  const out = await run({ question: "Proceed?", context: "Destructive operation", options: ["yes", "no"] }, signal);
  status(out, "forwarded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "nested");
  assert.equal(calls[0][1], "agent_ping");
  assert.match(calls[0][2].message, /Question: Proceed\?/);
  assert.match(calls[0][2].message, /Context: Destructive operation/);
  assert.match(calls[0][2].message, /1\. yes\n2\. no/);
  assert.match(calls[0][2].message, /agent_resume/);
  assert.deepEqual(calls[0][3], { signal });
}));

test("missing nested API or unavailable agent_ping never falls back to UI", () => withSession(true, async () => {
  for (const absent of ["api", "tool"]) {
    const { run, ctx, calls } = setup();
    if (absent === "api") delete ctx.executeTool;
    else ctx.tools = [];
    const out = await run();
    status(out, "unavailable");
    assert.equal(out.isError, true);
    assert.match(out.details.message, /loaded and permitted/);
    assert.deepEqual(calls, []);
  }
}));

test("denied and thrown forwarding failures are actionable and never use UI", () => withSession(true, async () => {
  for (const failure of ["denied", "result-error", "throw"]) {
    const { run, ctx, calls } = setup();
    ctx.executeTool = async () => {
      if (failure === "throw") throw new Error("not callable");
      return { isError: failure === "denied", result: { isError: failure === "result-error" } };
    };
    const out = await run();
    status(out, "unavailable");
    assert.match(out.details.message, /agent_ping directly/);
    assert.deepEqual(calls, []);
  }
}));

test("interrupted forwarding is unanswered; successful shutdown is still forwarded", () => withSession(true, async () => {
  for (const throws of [true, false]) {
    const { run, ctx, calls } = setup();
    const controller = new AbortController();
    ctx.executeTool = async () => {
      controller.abort(); // Models Herdr shutdown during a nested call.
      if (throws) throw new Error("shutdown interrupted result");
      return { isError: false, result: {} };
    };
    status(await run(undefined, controller.signal), throws ? "cancelled" : "forwarded");
    assert.deepEqual(calls, []);
  }
}));

const userTurn = { messageType: "user", prompt: "test", systemPrompt: "Other extension instructions" };
const pingTurn = {
  messageType: "custom",
  message: { type: "custom_message", customType: "subagent_ping", content: "needs help", display: true },
  systemPrompt: "Other extension instructions",
};

test("a child always gets its guidance, and it composes without replacing the prompt", async () => {
  const { hooks, ctx } = setup();
  await withSession(true, async () => {
    const event = { ...userTurn };
    const out = await hooks.before_agent_start(event, ctx);
    assert.deepEqual(Object.keys(out), ["message"]);
    assert.equal(event.systemPrompt, "Other extension instructions");
    assert.equal(out.message.display, false);
    assert.match(out.message.content, /agent_resume/);
    assert.match(out.message.content, /Prefer calling agent_ping directly/);
    assert.match(out.message.content, /nested-tool shutdown/);
    assert.match(out.message.content, /never open user UI/);
  });
});

test("the parent gets ping guidance only on a ping, not on every turn", async () => {
  const { hooks } = setup();
  await withSession(false, async () => {
    const out = await hooks.before_agent_start({ ...pingTurn }, {});
    assert.equal(out.message.display, false);
    assert.match(out.message.content, /Herdr child is waiting on you/);
    assert.match(out.message.content, /Otherwise ask the user/);
    assert.match(out.message.content, /agent_resume/);
    assert.match(out.message.content, /Cancellation is unanswered/);
  });
});

test("an ordinary parent prompt receives no guidance at all", async () => {
  const { hooks } = setup();
  await withSession(false, async () => {
    // A bare "test" must not arrive with a hidden instruction about pings and
    // child sessions, which previously turned it into a protocol recital.
    assert.equal(await hooks.before_agent_start({ ...userTurn }, {}), undefined);
    // Another extension's custom message is not a ping either.
    for (const customType of ["subagent_result", "ask-user-guidance", "artifact"]) {
      const event = { ...pingTurn, message: { ...pingTurn.message, customType } };
      assert.equal(await hooks.before_agent_start(event, {}), undefined, customType);
    }
  });
});
