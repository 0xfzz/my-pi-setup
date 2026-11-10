import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webExtension, { bridgeHeaders } from "../extensions/web.ts";
import { loadWebAuthConfig, writeWebPassword } from "../lib/web-auth/config.ts";
import { verifyPassword } from "../lib/web-auth/password.ts";

const PASSWORD = "correct horse battery";

interface Harness {
  run: (args: string) => Promise<void>;
  notes: Array<{ message: string; level: string }>;
  configPath: string;
  prompts: string[];
}

async function withCommand(answers: Array<string | undefined>, fn: (h: Harness) => Promise<void>, confirm = true): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-pw-"));
  const configPath = join(dir, "web-auth.json");
  try {
    let descriptor: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const pi: any = {
      registerCommand(name: string, desc: any) {
        if (name === "web") descriptor = desc;
      },
      on: () => undefined,
    };
    const notes: Harness["notes"] = [];
    const prompts: string[] = [];
    const queue = [...answers];
    const ctx: any = {
      sessionManager: { getSessionId: () => "s" },
      ui: {
        notify: (message: string, level: string) => notes.push({ message, level }),
        confirm: async () => confirm,
      },
    };
    webExtension(pi, {
      authConfigPath: configPath,
      askSecret: async (_ctx, title) => {
        prompts.push(title);
        return queue.shift();
      },
      deps: { fetchHealth: async () => false, readState: async () => null },
    });
    assert.ok(descriptor);
    const handler = descriptor.handler;
    await fn({ run: (args) => handler(args, ctx), notes, configPath, prompts });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/web set-password hashes the password into a private file and says how to publish", async () => {
  await withCommand([PASSWORD, PASSWORD], async (h) => {
    await h.run("set-password");
    assert.deepEqual(h.prompts, ["New web password (at least 10 characters)", "Repeat the web password"]);
    const loaded = loadWebAuthConfig(h.configPath);
    assert.equal(loaded.state, "enabled");
    assert.equal(statSync(h.configPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(h.configPath, "utf8").includes(PASSWORD), false);
    assert.equal(loaded.state === "enabled" && (await verifyPassword(PASSWORD, loaded.config.passwordHash)), true);
    assert.equal(h.notes.at(-1)?.level, "info");
    assert.match(h.notes.at(-1)?.message ?? "", /PI_WEB_HOST=0\.0\.0\.0/);
  });
});

test("/web set-password refuses weak, mismatched, cancelled and inline passwords without touching the file", async () => {
  await withCommand(["short", PASSWORD, "something else entirely", undefined, PASSWORD, undefined], async (h) => {
    await h.run("set-password");
    assert.match(h.notes.at(-1)?.message ?? "", /at least 10 characters/);
    await h.run("set-password");
    assert.match(h.notes.at(-1)?.message ?? "", /differ/);
    await h.run("set-password");
    await h.run("set-password");
    const before = h.notes.length;
    await h.run(`set-password ${PASSWORD}`);
    assert.match(h.notes.at(-1)?.message ?? "", /Do not put the password on the command line/);
    assert.equal(h.notes.length, before + 1);
    assert.equal(loadWebAuthConfig(h.configPath).state, "disabled");
    assert.equal(h.prompts.length, 6, "the inline attempt never prompted");
  });
});

test("/web set-password again rotates the credentials and reports a change", async () => {
  await withCommand([PASSWORD, PASSWORD, "another long password", "another long password"], async (h) => {
    await h.run("set-password");
    const first = loadWebAuthConfig(h.configPath);
    await h.run("set-password");
    const second = loadWebAuthConfig(h.configPath);
    assert.ok(first.state === "enabled" && second.state === "enabled");
    assert.notEqual(first.config.secret, second.config.secret);
    assert.match(h.notes.at(-1)?.message ?? "", /changed; every web session was signed out/);
  });
});

test("/web clear-password removes protection after confirmation, and status reports it", async () => {
  await withCommand([], async (h) => {
    await writeWebPassword(PASSWORD, h.configPath);
    await h.run("status");
    assert.match(h.notes.at(-1)?.message ?? "", /Password protection: on/);
    await h.run("clear-password");
    assert.equal(loadWebAuthConfig(h.configPath).state, "disabled");
    await h.run("status");
    assert.match(h.notes.at(-1)?.message ?? "", /Password protection: off/);
    await h.run("clear-password");
    assert.match(h.notes.at(-1)?.message ?? "", /No web password is set/);
  });
  await withCommand(
    [],
    async (h) => {
      await writeWebPassword(PASSWORD, h.configPath);
      await h.run("clear-password");
      assert.equal(loadWebAuthConfig(h.configPath).state, "enabled", "declining keeps the password");
    },
    false,
  );
});

test("bridgeHeaders adds the bridge token only while a password is set, and follows changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-bridge-"));
  const previous = process.env.PI_WEB_AUTH_FILE;
  process.env.PI_WEB_AUTH_FILE = join(dir, "web-auth.json");
  try {
    assert.deepEqual(bridgeHeaders({ accept: "x" }), { accept: "x" });
    const first = await writeWebPassword(PASSWORD, process.env.PI_WEB_AUTH_FILE);
    assert.deepEqual(bridgeHeaders({ accept: "x" }), { accept: "x", Authorization: `Bearer ${first.bridgeToken}` });
    const second = await writeWebPassword(PASSWORD, process.env.PI_WEB_AUTH_FILE);
    assert.equal(bridgeHeaders().Authorization, `Bearer ${second.bridgeToken}`);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_AUTH_FILE;
    else process.env.PI_WEB_AUTH_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
