/**
 * End-to-end: a real Pi runtime, the real modes extension, the real dashboard
 * extension, the real detached server, and the real HTTP browser API.
 *
 * Every other dashboard test stubs at least one of those boundaries. This one
 * stubs none of them, which is the only way to catch the class of defect that
 * lives *between* the pieces: a mode notice that never reaches the bridge, a
 * producer that starts but never publishes, a server that answers the producer
 * yet rejects the browser, or a shutdown that leaves a detached process behind.
 *
 * Deliberately excluded: any orchestrator child spawn. That path needs Herdr
 * panes, and it is covered by the orchestrator suite; here the dashboard must be
 * correct for a session that has not delegated anything yet, which is exactly
 * the state the first snapshot is published in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import dashboardExtension from "../extensions/dashboard.ts";
import modesExtension from "../extensions/modes.ts";
import {
  readDashboardAddress,
  stopDashboardByRuntimeDir,
  type DashboardAddress,
} from "../lib/dashboard/lifecycle.ts";

interface Browser {
  listSessions(): Promise<any[]>;
  getSession(id: string): Promise<any>;
}

/** Bootstrap like a browser does: exchange the URL token for the HttpOnly cookie. */
async function openBrowser(browserUrl: string): Promise<Browser> {
  const bootstrap = await fetch(browserUrl, { redirect: "manual" });
  assert.equal(bootstrap.status, 302, "bootstrap must redirect, not render");
  const setCookie = bootstrap.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  assert.match(cookie, /^pi_dashboard=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const root = new URL(browserUrl);
  const base = `${root.origin}/`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { cookie } });
    return response;
  };
  return {
    async listSessions() {
      const response = await get("api/sessions");
      assert.equal(response.status, 200, `api/sessions failed: ${response.status}`);
      return ((await response.json()) as any).sessions as any[];
    },
    async getSession(id: string) {
      const response = await get(`api/session?id=${encodeURIComponent(id)}`);
      assert.equal(response.status, 200, `api/session failed: ${response.status}`);
      return ((await response.json()) as any).session;
    },
  };
}

/** Poll a condition without pinning the test to a specific publication order. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
}
