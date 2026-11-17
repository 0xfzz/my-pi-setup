import test from "node:test";
import assert from "node:assert/strict";
import { createWebApp } from "./app.ts";
import { registerCoreRoutes } from "./routes.ts";
import { httpLoggerOptions, lineLogStream, requestLogFields } from "../http/observability.ts";

function captureLogs(): { lines: string[]; destination: ReturnType<typeof lineLogStream> } {
  const lines: string[] = [];
  return { lines, destination: lineLogStream(line => lines.push(line)) };
}

test("the request log serializer drops the query string that can carry a token", () => {
  const fields = requestLogFields({ method: "GET", url: "/bootstrap?token=secret", host: "127.0.0.1", ip: "127.0.0.1", socket: { remotePort: 5000 } } as never);
  assert.equal(fields.url, "/bootstrap");
  assert.ok(!JSON.stringify(fields).includes("secret"));
  assert.equal(fields.host, "127.0.0.1");
});

test("framework error logs carry a request id and no query/header/body credentials", async () => {
  const { lines, destination } = captureLogs();
  const app = await createWebApp({ logger: { ...httpLoggerOptions(), stream: destination } });
  app.get("/boom", async () => { throw new Error("boom"); });
  try {
    const response = await app.inject({
      url: "/boom?token=bootstrap-secret",
      headers: { authorization: "Bearer bridge-secret", cookie: "pi_web_at=access-secret" },
      payload: { password: "body-secret" },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]!);
    assert.equal(logged.level, 50);
    assert.equal(logged.msg, "unhandled request error");
    assert.match(String(logged.reqId), /^req-\d+$/);
    const raw = lines.join("");
    for (const secret of ["bootstrap-secret", "bridge-secret", "access-secret", "body-secret"]) assert.ok(!raw.includes(secret), secret);
  } finally {
    await app.close();
  }
});

test("browser log entries reach the shared structured logger with their stack", async () => {
  const { lines, destination } = captureLogs();
  const app = await createWebApp({ logger: { ...httpLoggerOptions(), level: "info", stream: destination } });
  await registerCoreRoutes(app);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/client/log",
      payload: { entries: [{ level: "error", message: "browser failed", stack: "Error: browser failed\n  at app.js", ts: 42, source: "browser" }] },
    });
    assert.equal(response.statusCode, 200);
    const forwarded = lines.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.source === "browser");
    assert.equal(forwarded?.msg, "browser failed");
    assert.equal(forwarded?.browserTs, 42);
    assert.match(String((forwarded?.err as { stack?: string } | undefined)?.stack), /at app\.js/);
    assert.equal(forwarded?.level, 50);
  } finally {
    await app.close();
  }
});

test("request ids are assigned even when the logger is off", async () => {
  const app = await createWebApp();
  let id: string | undefined;
  app.get("/id", async request => { id = request.id; return { ok: true }; });
  try {
    assert.equal((await app.inject("/id")).statusCode, 200);
    assert.ok(id !== undefined && id !== "");
  } finally {
    await app.close();
  }
});
