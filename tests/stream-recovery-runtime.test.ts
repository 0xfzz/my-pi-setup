import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../extensions/stream-recovery.ts";

for (const [tool, native, blocked, length, malformed] of [
  ["write", true, false, false, false], ["bash", true, false, false, false],
  ["write", false, false, false, false], ["bash", true, true, false, false],
  ["write", true, false, true, false], ["write", true, false, true, "stream"],
  ["bash", true, false, true, "diagnostic"],
] as const) {
  test(`real Pi ${length ? `output limit (${malformed || "parsed"})` : native ? "native retry" : "automatic recovery"} ${blocked ? "blocks" : "continues"} an interrupted ${tool} through original hooks`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-stream-runtime-"));
    let session: any;
    let requests = 0;
    const errors: unknown[] = [];
    const nested: any[] = [];
    let settled!: () => void;
    const completed = new Promise<void>(resolve => { settled = resolve; });
    const prefix = tool === "write" ? "# PRD\n" + "Plugin requirement\n".repeat(1000) : "printf '%s' 'hello\n";
    const suffix = tool === "write" ? "Last requirement\n" : "world' > command-result.txt";
    const model: any = {
      id: "recovery", name: "Recovery", provider: `stream-test-${tool}`, api: `stream-scripted-${tool}`,
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    try {
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, cacheWarming: "off" });
      const manager = SessionManager.create(dir, dir);
      const loader = new DefaultResourceLoader({
        cwd: dir, agentDir: dir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [extension, pi => {
          pi.on("tool_call", event => {
            if (event.parentToolCallId) {
              nested.push(event);
              if (blocked) return { block: true, reason: "test permission gate" };
            }
          });
          pi.registerProvider(model.provider, {
            api: model.api, baseUrl: model.baseUrl, apiKey: "local-test", models: [model],
            streamSimple: (_model: any, context: any) => {
              requests++;
              let content: any[];
              let raw: string | undefined;
              if (requests === 1) {
                content = [{ type: "toolCall", id: "cut", name: tool, arguments: tool === "write"
                  ? { path: "prd.md", content: prefix + "unfinished final line" }
                  : { command: prefix + "unfinished" } }];
                if (malformed) {
                  raw = JSON.stringify(content[0].arguments).slice(0, -2);
                  content[0].arguments = {};
                  content[0].argumentsError = malformed === "diagnostic"
                    ? `Unexpected end of JSON input\n\nReceived arguments:\n${raw}`
                    : "Unexpected end of JSON input";
                }
              } else if (requests === 2) {
                assert.equal(existsSync(join(dir, tool === "write" ? "prd.md" : "command-result.txt")), false, "partial generation must not mutate targets");
                const hint = context.messages.map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("\n"))
                  .find((text: string) => text.includes("[Stream recovery:"));
                assert.ok(hint, "checkpoint must reach the next native retry even though Pi omits the failed attempt");
                assert.ok(hint.length < 3000);
                if (length) {
                  const failure = context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "cut");
                  assert.equal(failure.isError, true);
                  const text = failure.content.map((c: any) => c.text ?? "").join("\n");
                  assert.match(text, /output token limit.*Saved prefix:/);
                  assert.match(text, /recover_stream/);
                  assert.doesNotMatch(text, /Re-issue the tool call with complete arguments/);
                }
                const data = JSON.parse(hint.split("\n").find((line: string) => line.startsWith('{"id":')));
                content = [{ type: "toolCall", id: "recovered", name: "recover_stream", arguments: { id: data.id, version: data.version, finish: true, suffix } }];
              } else content = [{ type: "text", text: "done" }];
              const message: any = {
                role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
                stopReason: requests === 1 ? length ? "length" : "error" : requests === 2 ? "toolUse" : "stop",
                ...(requests === 1 && !length ? { errorMessage: `${native ? "upstream_stream_read_error: " : ""}upstream stream ended before completion` } : {}),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              const stream = createAssistantMessageEventStream();
              stream.push({ type: "start", partial: message });
              if (raw && malformed === "stream") {
                const middle = Math.floor(raw.length / 2);
                for (const delta of [raw.slice(0, middle), raw.slice(middle)]) {
                  stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: message });
                }
              }
              if (requests === 1 && !length) stream.push({ type: "error", reason: "error", error: message });
              else stream.push({ type: "done", reason: message.stopReason, message });
              return stream;
            },
          });
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager: settings, sessionManager: manager, model }));
      await session.bindExtensions({
        onError: (error: unknown) => errors.push(error), mode: "rpc",
        ...(!native ? { uiContext: { notify() {} } as any } : {}),
      });
      session.subscribe((event: any) => {
        if (event.type === "agent_settled" && requests >= 3) settled();
        if (event.type === "auto_retry_start") {
          // At this boundary generation failed but no original tool may have run.
          assert.equal(nested.length, 0);
        }
      });
      await session.prompt("Complete the requested file or command");
      if (!native) await completed;
      assert.equal(requests, 3, session.messages.at(-1)?.errorMessage);
      assert.deepEqual(errors, []);
      assert.equal(nested.length, 1);
      assert.equal(nested[0].toolName, tool);
      assert.equal(nested[0].parentToolCallId, "recovered");
      if (blocked) assert.equal(existsSync(join(dir, "command-result.txt")), false, "nested recovery cannot bypass permission gates");
      else if (tool === "write") assert.equal(await readFile(join(dir, "prd.md"), "utf8"), prefix + suffix);
      else assert.equal(await readFile(join(dir, "command-result.txt"), "utf8"), "hello\nworld");
      const result = session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "recover_stream");
      assert.equal(result.isError, blocked, JSON.stringify(result));
      assert.equal(result.nestedCalls.calls[0].name, tool);
      await access(manager.getSessionFile()!);
    } finally {
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
