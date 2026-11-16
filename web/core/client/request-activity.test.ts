import test from "node:test";
import assert from "node:assert/strict";
import { createRequestActivity, isTurnRequest } from "./request-activity.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("loading starts before fetch and stays active until every concurrent request settles", async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const responses = [first, second];
  const activity = createRequestActivity(async () => {
    assert.ok(activity.getSnapshot() > 0, "loading is already published before network work starts");
    return responses.shift()?.promise ?? new Response("ok");
  });
  const changes: number[] = [];
  const unsubscribe = activity.subscribe(() => changes.push(activity.getSnapshot()));
  const a = activity.fetch("/api/first");
  const b = activity.fetch("/api/second");
  assert.equal(activity.getSnapshot(), 2);
  first.resolve(new Response("ok"));
  await a;
  assert.equal(activity.getSnapshot(), 1, "one completed request cannot hide another's loader");
  second.resolve(new Response("ok"));
  await b;
  assert.equal(activity.getSnapshot(), 0);
  assert.deepEqual(changes, [1, 2, 1, 0]);
  unsubscribe();
  await activity.fetch("/api/third");
  assert.deepEqual(changes, [1, 2, 1, 0], "unsubscribed listeners are not notified");
});

test("network errors and aborted requests clear loading without swallowing the error", async () => {
  for (const error of [new Error("offline"), new DOMException("cancelled", "AbortError")]) {
    const response = deferred<Response>();
    const activity = createRequestActivity(() => response.promise);
    const request = activity.fetch("/api/failed");
    response.reject(error);
    await assert.rejects(request, actual => actual === error);
    assert.equal(activity.getSnapshot(), 0);
  }
});

test("loading covers a slow response body, not just the arrival of HTTP headers", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  const activity = createRequestActivity(async () => new Response(body, {
    status: 201, headers: { "Content-Type": "application/json" },
  }));
  const response = await activity.fetch("/api/slow-body");
  assert.ok(response instanceof Response);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const reading = response.json();
  assert.equal(activity.getSnapshot(), 1, "the body is still loading after headers arrive");
  stream.enqueue(new TextEncoder().encode('{"ready":true}'));
  stream.close();
  assert.deepEqual(await reading, { ready: true });
  assert.equal(response.bodyUsed, true);
  assert.equal(activity.getSnapshot(), 0);
});

test("invalid bodies clear loading and cloned responses retain native read semantics", async () => {
  const activity = createRequestActivity(async () => new Response("not JSON"));
  const response = await activity.fetch("/api/bad-json");
  const clone = response.clone();
  await assert.rejects(response.json(), SyntaxError);
  assert.equal(activity.getSnapshot(), 0);
  assert.equal(await clone.text(), "not JSON");
  assert.equal(activity.getSnapshot(), 0);
  await assert.rejects(clone.text(), TypeError);
  assert.equal(activity.getSnapshot(), 0);
});

test("loading preserves fetch arguments and streamed response metadata", async () => {
  const input = new Request("https://example.test/api/file");
  const init = { signal: new AbortController().signal };
  const activity = createRequestActivity(async (actualInput, actualInit) => {
    assert.equal(actualInput, input);
    assert.equal(actualInit, init);
    return Response.redirect("https://example.test/next", 307);
  });
  const response = await activity.fetch(input, init);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://example.test/next");
  assert.equal(response.body, null);
  assert.equal(activity.getSnapshot(), 0);
});

const SESSION = "/api/agent/01a1c103-session";
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

test("a prompt or web command to a session is a turn request, the rest are not", () => {
  assert.equal(isTurnRequest(SESSION, post({ type: "prompt", message: "hi" })), true);
  assert.equal(isTurnRequest(SESSION, post({ type: "web_command", name: "reload" })), true);
  assert.equal(isTurnRequest(SESSION, post({ type: "abort" })), false, "abort answers at once");
  assert.equal(isTurnRequest(SESSION, { method: "GET" }), false);
  assert.equal(isTurnRequest(`${SESSION}/history`, { method: "GET" }), false);
  assert.equal(isTurnRequest("/api/agent/new", post({ type: "prompt" })), false, "creating a session is not a turn");
  assert.equal(isTurnRequest(SESSION, { method: "POST", body: "not json" }), false);
  assert.equal(isTurnRequest(new URL(`http://x${SESSION}`), post({ type: "prompt", message: "x" })), true);
});

test("a turn request is not counted, so the loading card stays down for the whole reply", async () => {
  const turn = deferred<Response>();
  const activity = createRequestActivity(() => turn.promise);
  const reply = activity.fetch(SESSION, post({ type: "prompt", message: "long task" }));
  assert.equal(activity.getSnapshot(), 0, "a prompt that waits out the turn is not network work");
  turn.resolve(new Response("ok"));
  await reply;
});

test("ordinary requests are still counted while a turn is running", async () => {
  const turn = deferred<Response>();
  const history = deferred<Response>();
  const activity = createRequestActivity((input) => (String(input).endsWith("/history") ? history.promise : turn.promise));
  const reply = activity.fetch(SESSION, post({ type: "prompt", message: "x" }));
  const read = activity.fetch(`${SESSION}/history`);
  assert.equal(activity.getSnapshot(), 1);
  history.resolve(new Response("ok"));
  await read;
  turn.resolve(new Response("ok"));
  await reply;
  assert.equal(activity.getSnapshot(), 0);
});
