import test from "node:test";
import assert from "node:assert/strict";
import { externalSessionHostEnabled, isSessionHostProcess, parseSessionHostPid, sessionHostArgs, sessionHostEnv, sessionHostPidPath, type SessionHostRequest } from "../lib/session-host.ts";

const request: SessionHostRequest = {
  sessionId: "session-123",
  cwd: "/repo",
  serverUrl: "http://127.0.0.1:30142",
  extensionPath: "/repo/extensions/web.ts",
};

test("stable session hosting is on for real POSIX servers and can be opted out", () => {
  assert.equal(externalSessionHostEnabled({}, "linux"), false);
  assert.equal(externalSessionHostEnabled({ PI_WEB_SESSION_HOST: "0" }, "linux"), false);
  assert.equal(externalSessionHostEnabled({ PI_WEB_SESSION_HOST: "1" }, "linux"), true);
  assert.equal(externalSessionHostEnabled({ PI_WEB_SESSION_HOST: "1" }, "win32"), false);
});

test("only the detached owner process treats itself as a session host", () => {
  assert.equal(isSessionHostProcess({ PI_WEB_SESSION_HOST: "1" }), false);
  assert.equal(isSessionHostProcess({ PI_WEB_SESSION_HOST_OWNER: "1", PI_WEB_SERVER_PROCESS: "1" }), false);
  assert.equal(isSessionHostProcess({ PI_WEB_SESSION_HOST_OWNER: "1" }), true);
});

test("owner pid records and paths are strict enough for a shared agent dir", () => {
  assert.equal(parseSessionHostPid("4321\n"), 4321);
  assert.equal(parseSessionHostPid("nonsense"), null);
  assert.equal(parseSessionHostPid("-1"), null);
  assert.equal(sessionHostPidPath("/agent", "session-1"), "/agent/web-session-hosts/session-1.pid");
  assert.throws(() => sessionHostPidPath("/agent", "../escape"));
});

test("a new session host gets an exact id and explicit extension path", () => {
  assert.deepEqual(sessionHostArgs(request), [
    "--mode", "rpc", "--session-id", "session-123", "--extension", "/repo/extensions/web.ts",
  ]);
});

test("a resumed session host opens the session file", () => {
  assert.deepEqual(sessionHostArgs({ ...request, sessionFile: "/sessions/abc.jsonl" }), [
    "--mode", "rpc", "--session-id", "session-123", "--session", "/sessions/abc.jsonl",
    "--extension", "/repo/extensions/web.ts",
  ]);
});

test("a session host environment cannot think it is the server or attach twice", () => {
  const env = sessionHostEnv(request, {
    PATH: "/bin",
    PI_WEB_SERVER_PROCESS: "1",
    NODE_TEST_CONTEXT: "1",
    PI_WEB_URL: "http://old",
    PI_WEB_AUTO_RELOAD: "1",
    PI_WEB_SESSION_HOST: "0",
    PI_WEB_SESSION_HOST_EXTENSION_MARKER: "1",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal("PI_WEB_SERVER_PROCESS" in env, false);
  assert.equal("NODE_TEST_CONTEXT" in env, false);
  assert.equal("PI_WEB_SESSION_HOST_EXTENSION_MARKER" in env, false);
  assert.equal(env.PI_WEB_URL, "http://127.0.0.1:30142");
  assert.equal(env.PI_WEB_AUTO_RELOAD, "0");
  assert.equal(env.PI_WEB_SESSION_HOST, "1");
  assert.equal(env.PI_WEB_SESSION_HOST_OWNER, "1");
});
