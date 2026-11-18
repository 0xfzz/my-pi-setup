/** Regression: image prompts must reach the session owner, or be named failures. */
import test from "node:test";
import assert from "node:assert/strict";

import { createSessionAdapters, type SessionSurface } from "./session.ts";

function owner(): { surface: SessionSurface; calls: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }> } {
  const calls: Array<{ text: string; images?: Array<{ data: string; mimeType: string }> }> = [];
  return {
    calls,
    surface: {
      prompt: (text, images) => { calls.push({ text, ...(images === undefined ? {} : { images }) }); },
      abort: () => undefined,
    },
  };
}

const context = { cwd: "/tmp", grantedCapabilities: [] };
const signal = new AbortController().signal;

test("session.prompt forwards validated images to the owner", async () => {
  const { surface, calls } = owner();
  const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
  const result = await createSessionAdapters(surface)["session.prompt"](context, { text: "look", images }, signal);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ text: "look", images }]);
});

test("session.boot reads the four initial surfaces in one adapter call", async () => {
  const surface: SessionSurface = {
    prompt: () => undefined,
    abort: () => undefined,
    get: () => ({ state: { model: { provider: "openai", id: "gpt" } } }),
    branch: () => "feature/pi-web",
    models: () => ({ models: [{ provider: "openai", id: "gpt" }] }),
    commands: () => [{ name: "review", description: "review the diff" }],
  };
  const result = await createSessionAdapters(surface)["session.boot"](context, {}, signal);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, {
      session: { state: { model: { provider: "openai", id: "gpt" } } },
      branch: "feature/pi-web",
      models: { models: [{ provider: "openai", id: "gpt" }] },
      commands: [{ name: "review", description: "review the diff" }],
    });
  }
});

test("session.boot omits unavailable surfaces instead of failing the whole read", async () => {
  const surface: SessionSurface = { prompt: () => undefined, abort: () => undefined, branch: () => "main" };
  const result = await createSessionAdapters(surface)["session.boot"](context, {}, signal);
  assert.deepEqual(result, { ok: true, value: { branch: "main" } });
});

test("session.prompt refuses invalid images without throwing", async () => {
  const { surface, calls } = owner();
  const adapter = createSessionAdapters(surface)["session.prompt"];
  for (const images of [
    [{ data: "", mimeType: "image/png" }],
    [{ data: "aGVsbG8=", mimeType: "text/plain" }],
    Array.from({ length: 9 }, () => ({ data: "aGVsbG8=", mimeType: "image/png" })),
  ]) {
    const result = await adapter(context, { text: "look", images }, signal);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(["ADAPTER_UNAVAILABLE"].includes(result.error.code));
  }
  assert.deepEqual(calls, []);
});
