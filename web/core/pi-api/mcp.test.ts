import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePiApiRequest } from "../server/pi-api.ts";
import type { PiMcpConfigState } from "../shared/pi-api.ts";

/** A disposable agent dir + trusted project cwd; env restored afterwards. */
async function withMcpWorld(
  run: (world: { agentDir: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "mcp-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "mcp-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const trustManager = await import(
      "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/trust-manager.js"
    );
    const store = new (trustManager as { ProjectTrustStore: new (dir: string) => {
      setMany(updates: Array<{ path: string; decision: boolean }>): void;
    } }).ProjectTrustStore(agentDir);
    store.setMany([{ path: cwd, decision: true }]);
    await run({ agentDir, cwd });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readState(cwd: string): Promise<PiMcpConfigState> {
  const outcome = await handlePiApiRequest(cwd, { api: "mcp.read", params: {} });
  assert.equal(outcome.status, 200);
  assert.ok(outcome.body.ok, outcome.body.ok ? "" : outcome.body.error);
  if (!outcome.body.ok) throw new Error("unreachable");
  return outcome.body.result;
}

async function write(cwd: string, params: unknown): Promise<{ ok: boolean; state?: PiMcpConfigState; error?: string }> {
  const outcome = await handlePiApiRequest(cwd, { api: "mcp.write", params });
  if (outcome.body.ok) return { ok: true, state: outcome.body.result as PiMcpConfigState };
  return { ok: false, error: outcome.status === 200 ? outcome.body.error : "rejected" };
}

test("mcp.read reports pi's merged configuration for the session cwd", async () => {
  await withMcpWorld(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "pkg"] } } }),
      "utf8",
    );
    const state = await readState(cwd);
    assert.equal(state.servers.length, 1);
    assert.equal(state.servers[0].name, "filesystem");
    assert.equal(state.servers[0].transport, "stdio");
    assert.equal(state.servers[0].command, "npx");
    assert.deepEqual(state.servers[0].args, ["-y", "pkg"]);
    assert.equal(state.servers[0].enabled, true);
    assert.equal(state.servers[0].exposure, "codemode");
    assert.equal(state.globalConfigPath, join(agentDir, "mcp.json"));
    assert.equal(state.projectTrusted, true);
    assert.equal(state.projectConfigPath, join(cwd, ".pi", "mcp.json"));
    assert.deepEqual(state.errors, []);
  });
});

test("mcp.write add puts a stdio server in the user mcp.json", async () => {
  await withMcpWorld(async ({ agentDir, cwd }) => {
    const outcome = await write(cwd, {
      action: "add",
      scope: "global",
      name: "docs",
      config: { url: "https://example.com/mcp", description: "docs server" },
    });
    assert.equal(outcome.ok, true);
    const names = outcome.state?.servers.map((server) => server.name);
    assert.deepEqual(names, ["docs"]);
    const file = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(file.mcpServers.docs.url, "https://example.com/mcp");
    assert.equal(file.mcpServers.docs.description, "docs server");
  });
});

test("mcp.write add rejects a config pi's validator refuses", async () => {
  await withMcpWorld(async ({ cwd }) => {
    const outcome = await write(cwd, {
      action: "add",
      scope: "global",
      name: "broken",
      config: { timeout: 30 },
    });
    assert.equal(outcome.ok, false);
    const state = await readState(cwd);
    assert.deepEqual(state.servers, []);
  });
});

test("mcp.write patch flips enabled in the file that defines the entry", async () => {
  await withMcpWorld(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx" } } }),
      "utf8",
    );
    const outcome = await write(cwd, { action: "patch", name: "fs", enabled: false });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.state?.servers[0].enabled, false);
    const file = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(file.mcpServers.fs.enabled, false);
  });
});

test("mcp.write patch fails for a name pi does not have configured", async () => {
  await withMcpWorld(async ({ cwd }) => {
    const outcome = await write(cwd, { action: "patch", name: "ghost", enabled: false });
    assert.equal(outcome.ok, false);
  });
});

test("mcp.write project changes need a trusted project", async () => {
  await withMcpWorld(async ({ agentDir }) => {
    const untrusted = await mkdtemp(join(tmpdir(), "mcp-untrusted-"));
    try {
      const outcome = await write(untrusted, {
        action: "add",
        scope: "project",
        name: "local",
        config: { command: "npx" },
      });
      assert.equal(outcome.ok, false);
      const state = await readState(untrusted);
      assert.equal(state.projectConfigPath, null, "untrusted project exposes no project config");
      assert.equal(state.globalConfigPath, join(agentDir, "mcp.json"));
    } finally {
      await rm(untrusted, { recursive: true, force: true });
    }
  });
});

test("mcp.write project override stores an enabled:false stub and survives a global patch", async () => {
  await withMcpWorld(async ({ agentDir, cwd }) => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fs: { command: "npx" } } }),
      "utf8",
    );
    const override = await write(cwd, { action: "override", name: "fs", enabled: false });
    assert.equal(override.ok, true);
    const project = JSON.parse(await readFile(join(cwd, ".pi", "mcp.json"), "utf8"));
    assert.equal(project.mcpServers.fs.enabled, false);
    // The merged entry keeps the global definition and shows the override.
    const merged = override.state?.servers[0];
    assert.equal(merged?.command, "npx");
    assert.equal(merged?.enabled, false);
    assert.equal(merged?.override, join(cwd, ".pi", "mcp.json"));
    // Removing the project override restores the global server.
    const restored = await write(cwd, { action: "remove", scope: "project", name: "fs" });
    assert.equal(restored.ok, true);
    assert.equal(restored.state?.servers[0].enabled, true);
  });
});

test("mcp.write remove drops the entry from the requested file", async () => {
  await withMcpWorld(async ({ agentDir, cwd }) => {
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { gone: { url: "https://example.com" } } }),
      "utf8",
    );
    const outcome = await write(cwd, { action: "remove", scope: "global", name: "gone" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.state?.servers, []);
    const file = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(file.mcpServers.gone, undefined);
  });
});

test("mcp.write rejects an invalid name at the wire", async () => {
  await withMcpWorld(async ({ cwd }) => {
    const outcome = await write(cwd, {
      action: "add",
      scope: "global",
      name: "has space",
      config: { command: "npx" },
    });
    assert.equal(outcome.ok, false);
  });
});
