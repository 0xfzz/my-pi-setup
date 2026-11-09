import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { POST } = await jiti.import("./route.ts");
const {
  webPluginsStore,
  attachSessionPlugins,
  getActionAuditLog,
  WEB_PLUGIN_ACTION_REQUEST_EVENT,
} = await jiti.import("@/lib/web-plugins-host.ts");

function createPostRequest(body) {
  return new Request("http://localhost/api/plugins/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("AC1: POST with wrong or missing confirm returns 403 and leaves event bus untouched", async () => {
  webPluginsStore.clear();

  let busCalls = 0;
  const mockEventBus = {
    on() {
      return () => {};
    },
    emit() {
      busCalls++;
    },
  };

  attachSessionPlugins({
    sessionId: "sess-ac1",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
  });

  // 1. Wrong confirm string
  const wrongConfirmRes = await POST(
    createPostRequest({
      sessionId: "sess-ac1",
      pluginId: "dashboard",
      actionId: "request-sync",
      confirm: "wrong string",
    }),
  );
  assert.equal(wrongConfirmRes.status, 403);
  assert.equal(busCalls, 0, "Event bus must not be called on wrong confirm");

  // 2. Missing confirm string
  const missingConfirmRes = await POST(
    createPostRequest({
      sessionId: "sess-ac1",
      pluginId: "dashboard",
      actionId: "request-sync",
    }),
  );
  assert.equal(missingConfirmRes.status, 403);
  assert.equal(busCalls, 0, "Event bus must not be called on missing confirm");

  // 3. Confirm with whitespace mismatch (byte-identical check)
  const paddedConfirmRes = await POST(
    createPostRequest({
      sessionId: "sess-ac1",
      pluginId: "dashboard",
      actionId: "request-sync",
      confirm: "request sync ",
    }),
  );
  assert.equal(paddedConfirmRes.status, 403);
  assert.equal(busCalls, 0, "Byte-identical check must reject trailing space");

  assert.equal(getActionAuditLog().length, 0, "No audit log recorded on 403");
});

test("AC2: unknown sessionId, pluginId, or actionId returns 404 before any relay", async () => {
  webPluginsStore.clear();

  let busCalls = 0;
  const mockEventBus = {
    on() {
      return () => {};
    },
    emit() {
      busCalls++;
    },
  };

  attachSessionPlugins({
    sessionId: "sess-known",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
  });

  // 1. Unknown sessionId
  const badSessionRes = await POST(
    createPostRequest({
      sessionId: "sess-unknown",
      pluginId: "dashboard",
      actionId: "request-sync",
      confirm: "request sync",
    }),
  );
  assert.equal(badSessionRes.status, 404);
  assert.equal(busCalls, 0);

  // 2. Unknown pluginId
  const badPluginRes = await POST(
    createPostRequest({
      sessionId: "sess-known",
      pluginId: "unknown-plugin",
      actionId: "request-sync",
      confirm: "request sync",
    }),
  );
  assert.equal(badPluginRes.status, 404);
  assert.equal(busCalls, 0);

  // 3. Unknown actionId for known plugin
  const badActionRes = await POST(
    createPostRequest({
      sessionId: "sess-known",
      pluginId: "dashboard",
      actionId: "nonexistent-action",
      confirm: "request sync",
    }),
  );
  assert.equal(badActionRes.status, 404);
  assert.equal(busCalls, 0);

  assert.equal(getActionAuditLog().length, 0, "No audit log recorded on 404");
});

test("AC3: valid request emits exactly one event with fresh single-use requestId; concurrent second returns 409", async () => {
  webPluginsStore.clear();

  const emitted = [];
  const mockEventBus = {
    on() {
      return () => {};
    },
    emit(channel, data) {
      emitted.push({ channel, data });
    },
  };

  attachSessionPlugins({
    sessionId: "sess-valid",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
  });

  // 1. First valid request -> 200
  const res1 = await POST(
    createPostRequest({
      sessionId: "sess-valid",
      pluginId: "dashboard",
      actionId: "request-sync",
      confirm: "request sync",
    }),
  );
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.ok(typeof body1.requestId === "string" && body1.requestId.length > 0);
  assert.equal(body1.relayed, true);

  // Exactly one event emitted
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].channel, WEB_PLUGIN_ACTION_REQUEST_EVENT);
  assert.deepEqual(emitted[0].data, {
    requestId: body1.requestId,
    sessionId: "sess-valid",
    pluginId: "dashboard",
    actionId: "request-sync",
  });

  // Audit log recorded
  const audit = getActionAuditLog();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].requestId, body1.requestId);
  assert.equal(audit[0].sessionId, "sess-valid");
  assert.equal(audit[0].pluginId, "dashboard");
  assert.equal(audit[0].actionId, "request-sync");

  // 2. Second concurrent request on same session -> 409
  const res2 = await POST(
    createPostRequest({
      sessionId: "sess-valid",
      pluginId: "dashboard",
      actionId: "request-sync",
      confirm: "request sync",
    }),
  );
  assert.equal(res2.status, 409);
  assert.equal(emitted.length, 1, "No second event emitted on 409");
  assert.equal(audit.length, 1, "No second audit line recorded on 409");
});

test("POST returns 400 on malformed JSON body", async () => {
  const res = await POST(createPostRequest("not-valid-json"));
  assert.equal(res.status, 400);
});

test("instant action: an action without a declared confirm submits without a typed string", async () => {
  webPluginsStore.clear();

  let busCalls = 0;
  const mockEventBus = {
    on() {
      return () => {};
    },
    emit() {
      busCalls++;
    },
  };

  attachSessionPlugins({
    sessionId: "sess-instant",
    inner: {
      resourceLoader: {
        eventBus: mockEventBus,
      },
    },
  });

  // The modes descriptor declares toggle-mode with no confirm and Alt+M: the
  // POST carries no confirm field and is accepted and relayed exactly once.
  const instantRes = await POST(
    createPostRequest({
      sessionId: "sess-instant",
      pluginId: "modes",
      actionId: "toggle-mode",
    }),
  );
  assert.equal(instantRes.status, 200);
  const instantBody = await instantRes.json();
  assert.equal(instantBody.ok, true);
  assert.ok(instantBody.requestId, "a single-use requestId is issued");
  assert.equal(busCalls, 1, "the instant action is relayed on the session bus");

  // A confirmed action on the same plugin still demands its exact string,
  // even after an instant action from the same descriptor was accepted.
  const refusedRes = await POST(
    createPostRequest({
      sessionId: "sess-instant",
      pluginId: "modes",
      actionId: "leave-plan",
    }),
  );
  assert.equal(refusedRes.status, 403);
  assert.equal(busCalls, 1, "nothing further is relayed on a refused confirm");
});
