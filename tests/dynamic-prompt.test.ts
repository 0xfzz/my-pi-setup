import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import dynamicPrompt, { activeTools, applyDynamicPrompt } from "../extensions/dynamic-prompt.ts";
import {
  DEFAULT_DYNAMIC_PROMPT_CONFIG,
  buildDynamicSections,
  capabilityFacts,
  derivedRules,
  generalPreamble,
  groupTools,
  preserveDefaultSections,
  renderToolList,
  snippetFor,
  toolsMissingSnippets,
  validateConfig,
  visibleTools,
  type PromptTool,
} from "../lib/dynamic-prompt.ts";

const CONFIG = { ...DEFAULT_DYNAMIC_PROMPT_CONFIG };

const tool = (name: string, extra: Partial<PromptTool> = {}): PromptTool => ({
  name, exposure: "direct", ...extra,
});

test("validateConfig falls back per field instead of rejecting wholesale", () => {
  assert.deepEqual(validateConfig(undefined), DEFAULT_DYNAMIC_PROMPT_CONFIG);
  assert.deepEqual(validateConfig({}), DEFAULT_DYNAMIC_PROMPT_CONFIG);
  assert.equal(validateConfig({ mode: "append" }).mode, "append");
  assert.equal(validateConfig({ mode: "nonsense" }).mode, DEFAULT_DYNAMIC_PROMPT_CONFIG.mode);
  // A bad field must not discard the good ones.
  assert.deepEqual(
    validateConfig({ mode: "off", maxSnippetChars: "wide", includeToolGuidelines: false }),
    { mode: "off", maxSnippetChars: DEFAULT_DYNAMIC_PROMPT_CONFIG.maxSnippetChars, includeToolGuidelines: false },
  );
  // Out-of-range widths clamp rather than throw.
  assert.equal(validateConfig({ maxSnippetChars: 5 }).maxSnippetChars, 40);
  assert.equal(validateConfig({ maxSnippetChars: 9999 }).maxSnippetChars, 400);
});

test("hidden tools are excluded and the rest are ordered", () => {
  const visible = visibleTools([
    tool("zeta"), tool("alpha"), tool("secret", { exposure: "hidden" }),
  ]);
  assert.deepEqual(visible.map((entry) => entry.name), ["alpha", "zeta"]);
});

test("a tool with no snippet still gets one, drawn from its description", () => {
  assert.equal(snippetFor(tool("x", { promptSnippet: "Declared one-liner." }), 110), "Declared one-liner.");
  // First sentence only, whitespace flattened.
  assert.equal(
    snippetFor(tool("x", { description: "Reads the kitchen sensor.\nSecond line detail." }), 110),
    "Reads the kitchen sensor.",
  );
  // No description at all: the name is still usable, never empty.
  assert.equal(snippetFor(tool("kitchen_sensor"), 110), "kitchen sensor");
  // Truncation happens on a word boundary with an ellipsis.
  const long = snippetFor(tool("x", { description: "word ".repeat(60) }), 40);
  assert.ok(long.endsWith("…"), long);
  assert.ok(long.length <= 41, `expected <=41 chars, got ${long.length}: ${long}`);
});

test("tools group by shared prefix and by MCP server, and lone tools are not families", () => {
  const families = groupTools([
    tool("browser"), tool("browser_login"), tool("browser_evidence"),
    tool("mcp__github__create_issue"), tool("mcp__github__list_repos"),
    tool("workflow_todo"), tool("read"),
  ]);
  const keys = families.map((family) => family.key);
  assert.ok(keys.includes("browser"), keys.join(","));
  assert.ok(keys.includes("mcp:github"), "each MCP server stays its own family");
  // A single tool sharing no prefix with another is not a "family of one".
  assert.ok(!keys.includes("workflow"), "one tool must not become its own family");
  assert.ok(!keys.includes("read"));
  assert.ok(keys.includes("other"), "lone tools gather under one heading");
  const other = families.find((family) => family.key === "other")!;
  assert.deepEqual(other.tools.map((entry) => entry.name), ["read", "workflow_todo"]);
});

test("the rendered tool list omits no visible tool", () => {
  // The core invariant: a registered tool the model is not told about is unusable.
  const tools = [
    tool("read", { promptSnippet: "Read a file." }),
    tool("kitchen_sensor", { description: "Reads the kitchen temperature." }),
    tool("mcp__docs__search"),
    tool("secret", { exposure: "hidden", description: "not for the model" }),
  ];
  const rendered = renderToolList(tools, CONFIG.maxSnippetChars);
  for (const name of ["read", "kitchen_sensor", "mcp__docs__search"]) {
    assert.ok(rendered.includes(name), `${name} must be listed`);
  }
  assert.equal(rendered.includes("secret"), false, "hidden tools are not listed");
  // Even a tool with neither snippet nor description appears.
  assert.ok(renderToolList([tool("bare")], 110).includes("bare"));
  assert.match(renderToolList([], 110), /no tools are registered/i);
});

test("capability facts and rules mention only tools that exist", () => {
  const filesOnly = [tool("read"), tool("grep"), tool("ls")];
  const facts = capabilityFacts(filesOnly);
  assert.ok(facts.some((fact) => /filesystem is readable/i.test(fact)));
  assert.equal(facts.some((fact) => /can be executed/i.test(fact)), false, "no shell, no shell claim");
  assert.equal(facts.some((fact) => /delegated/i.test(fact)), false, "no subagent, no delegation claim");

  const rules = derivedRules(filesOnly).join("\n");
  assert.match(rules, /Read a file before changing it/);
  // Every rule is conditional: none may reference a capability that is absent.
  assert.doesNotMatch(rules, /bash|powershell/i);
  assert.doesNotMatch(rules, /sub-agent/);
  assert.doesNotMatch(rules, /todo list/);
  assert.doesNotMatch(rules, /browser/i);

  const rich = [tool("read"), tool("bash"), tool("agent_spawn"), tool("todo_plan"), tool("ask_user")];
  const richRules = derivedRules(rich).join("\n");
  assert.match(richRules, /sub-agent/);
  assert.match(richRules, /todo_plan/);
  assert.match(richRules, /Ask only when/);
});

test("tool-declared guidelines are folded in, and can be turned off", () => {
  const tools = [tool("kitchen", { promptGuidelines: ["Never preheat an empty oven."] })];
  assert.match(derivedRules(tools).join("\n"), /Never preheat an empty oven/);
  assert.doesNotMatch(
    derivedRules(tools, { includeToolGuidelines: false }).join("\n"),
    /Never preheat an empty oven/,
  );
  // Duplicate bullets collapse.
  const dupes = derivedRules([
    tool("a", { promptGuidelines: ["Same."] }),
    tool("b", { promptGuidelines: ["Same."] }),
  ]).filter((rule) => rule === "Same.");
  assert.equal(dupes.length, 1);
});

test("the preamble is general purpose and does not vary with the tool count", () => {
  const preamble = generalPreamble(7);
  assert.match(preamble, /pi/);
  assert.match(preamble, /Do not assume every request is about code/i);
  assert.equal(preamble, generalPreamble(12), "a count would invalidate the cached prefix on every tool change");
  assert.equal(/\d/.test(preamble), false);
  assert.equal(/expert coding assistant/i.test(preamble), false);
  // An empty session says so rather than pretending it can act.
  assert.match(generalPreamble(0), /No tools are registered/i);
});

test("Pi's docs section is extracted verbatim, and absent when not rendered", () => {
  const rendered = "intro\n<docs>\n- Main documentation: /x/README.md\n</docs>\n<tools>\n- read: x\n</tools>";
  assert.deepEqual(preserveDefaultSections(rendered), { docs: "- Main documentation: /x/README.md" });
  assert.deepEqual(preserveDefaultSections("no docs here"), {});
});

test("replace mode re-supplies the sections customPrompt suppresses", () => {
  const options: any = {};
  const tools = [tool("read", { promptSnippet: "Read a file." }), tool("kitchen_sensor")];
  applyDynamicPrompt(options, tools, { ...CONFIG, mode: "replace" },
    "<docs>\n- Main documentation: /x\n</docs>");

  assert.match(options.customPrompt, /Do not assume every request is about code/i);
  assert.equal(/expert coding assistant/i.test(options.customPrompt), false);
  // tools/rules/docs would be suppressed by customPrompt; all three come back.
  assert.match(options.sections.tools, /kitchen_sensor/);
  assert.match(options.sections.rules, /Read a file before changing it/);
  assert.equal(options.sections.docs, "- Main documentation: /x");
  assert.match(options.sections.capabilities, /filesystem is readable/i);
  // Snippetless tools get a snippet so Pi's own list is complete too.
  assert.ok(options.toolSnippets.kitchen_sensor);
});

test("append mode leaves Pi's preamble and sections alone", () => {
  const options: any = { sections: { tools: "PI ORIGINAL TOOLS" } };
  applyDynamicPrompt(options, [tool("read"), tool("kitchen_sensor")], { ...CONFIG, mode: "append" },
    "<docs>\n- Main documentation: /x\n</docs>");
  assert.equal(options.customPrompt, undefined, "append must not replace the preamble");
  assert.equal(options.sections.tools, "PI ORIGINAL TOOLS", "pi's own tool list is kept");
  assert.equal(options.sections.docs, undefined, "pi's docs section is untouched");
  assert.match(options.sections.capabilities, /filesystem is readable/i);
  // Still closes the snippetless-tool gap, which is what append mode needs.
  assert.ok(options.toolSnippets.kitchen_sensor);
});

test("off mode changes nothing at all", () => {
  const options: any = {};
  applyDynamicPrompt(options, [tool("read")], { ...CONFIG, mode: "off" });
  assert.deepEqual(options, {});
});

/**
 * Regression for a bug this probe caught during development: `getAllTools()` is
 * the REGISTRY, not the loadout. A restricted mode (Plan mode deactivates
 * write/edit) would otherwise be told it can write — the same false-capability
 * bug that produced the Plan-mode allowlist warning.
 */
test("only the active loadout is described, never every registered tool", () => {
  const registry = [tool("read"), tool("grep"), tool("write"), tool("edit"), tool("bash")];
  const restricted = activeTools(registry, {
    selectedTools: ["read", "grep"], hiddenTools: [],
  });
  assert.deepEqual(restricted.map((entry) => entry.name), ["read", "grep"]);

  // Replace mode must not name a deactivated capability.
  const options: any = { selectedTools: ["read", "grep"], hiddenTools: [] };
  applyDynamicPrompt(options, registry, { ...CONFIG, mode: "replace" }, "");
  assert.equal(options.sections.tools.includes("write"), false, "a deactivated tool must not be listed");
  assert.equal(options.sections.tools.includes("edit"), false);
  assert.equal(options.sections.tools.includes("bash"), false, "a deactivated shell must not be offered");
  assert.ok(options.sections.tools.includes("read"));
  // The shell rule is conditional, so no deactivated tool is referenced anywhere.
  assert.doesNotMatch(options.sections.rules, /bash|powershell/i);
  assert.doesNotMatch(options.sections.capabilities, /executed on this machine/i);
  // Nor does a snippet get injected for a tool the request cannot call.
  assert.equal(options.toolSnippets.write, undefined);

  // Hidden declarations are excluded even when named as selected.
  assert.deepEqual(
    activeTools(registry, { selectedTools: ["read", "write"], hiddenTools: ["write"] }).map((t) => t.name),
    ["read"],
  );

  // With no loadout available, fall back to the full registry rather than an empty list.
  assert.equal(activeTools(registry, {}).length, registry.length);
});

test("toolsMissingSnippets names the tools Pi would hide", () => {
  assert.deepEqual(
    toolsMissingSnippets([tool("a"), tool("b", { promptSnippet: "x" }), tool("c", { exposure: "hidden" })]),
    ["a"],
  );
});

/**
 * End-to-end through real Pi: the two failures this extension exists to fix,
 * asserted on the actual provider request rather than on the helper functions.
 */
test("a real session gets a general prompt that lists every registered tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-dynamic-prompt-"));
  let session: any;
  const savedConfig = process.env.PI_CODING_AGENT_DIR;
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const model: any = {
    id: "dyn-prompt", name: "Dyn prompt", provider: "dyn-prompt-test", api: "dyn-prompt-scripted",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
  };
  const captured: string[] = [];
  const errors: unknown[] = [];
  try {
    // The extension reads its config from the agent dir; point it at an empty temp
    // dir so defaults apply and a developer's real config cannot change the result.
    process.env.PI_CODING_AGENT_DIR = dir;
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [dynamicPrompt, pi => {
        // A tool with NO promptSnippet: Pi's own list would omit it entirely.
        pi.registerTool({
          name: "kitchen_sensor", label: "Kitchen Sensor",
          description: "Reads the kitchen temperature in celsius.\nSecond line detail.",
          parameters: Type.Object({ sensor: Type.String() }),
          async execute() { return { content: [{ type: "text", text: "21C" }], details: {} }; },
        });
        pi.registerTool({
          name: "hidden_tool", label: "Hidden", description: "reachable only via another tool",
          exposure: "hidden", parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: "x" }], details: {} }; },
        });
        pi.registerProvider(model.provider, {
          api: model.api, baseUrl: model.baseUrl, apiKey: "local-test-not-a-secret", models: [model],
          streamSimple: (_m: any, context: any) => {
            captured.push(JSON.stringify(context.messages));
            const message: any = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          },
        });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const created = await createAgentSession({
      cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings,
      sessionManager: SessionManager.create(dir, dir), model,
    });
    session = created.session;
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    await session.prompt("what is the kitchen temperature?");

    const request = captured[0]!;
    // 1. The preamble is no longer code-only.
    assert.equal(request.includes("expert coding assistant"), false, "the code-only preamble must be gone");
    assert.ok(request.includes("Do not assume every request is about code"));
    // 2. The snippetless tool is listed: this is the bug the extension exists for.
    assert.ok(request.includes("kitchen_sensor"), "a registered tool must never be invisible");
    assert.ok(/kitchen temperature/i.test(request));
    // 3. Hidden tools stay out of the list.
    assert.equal(request.includes("hidden_tool"), false);
    // 4. Pi's docs section survives the preamble replacement.
    assert.ok(request.includes("<docs>"), "pi's own docs pointer is preserved");
    // 5. Built-ins are still described, so nothing was dropped wholesale.
    assert.ok(request.includes("<tools>"));
    assert.ok(request.includes("bash"));
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    if (savedConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the rendered sections do not depend on tool registration order", () => {
  const tools = [
    tool("read", { promptSnippet: "Read a file." }),
    tool("agent_spawn", { promptSnippet: "Spawn." }),
    tool("agent_close"),
    tool("mcp__docs__search"),
    tool("mcp__docs__fetch"),
  ];
  const forward = buildDynamicSections(tools, CONFIG);
  const reversed = buildDynamicSections([...tools].reverse(), CONFIG);
  assert.deepEqual(reversed, forward, "registration order must not change the cached prefix");
});
