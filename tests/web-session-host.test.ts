import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionHost } from "../web/core/server/session-host.ts";

test("a failed pi spawn rejects the request instead of crashing the web server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-spawn-error-"));
  const brokenPi = join(dir, "pi");
  writeFileSync(brokenPi, "#!/definitely/missing/interpreter\nexit 0\n");
  chmodSync(brokenPi, 0o755);
  const saved = {
    PI_WEB_PI_BIN: process.env.PI_WEB_PI_BIN,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_WEB_LOG_FILE: process.env.PI_WEB_LOG_FILE,
  };
  process.env.PI_WEB_PI_BIN = brokenPi;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_WEB_LOG_FILE = "off";
  try {
    await assert.rejects(
      startSessionHost({
        sessionId: "spawn-error",
        cwd: dir,
        timeoutMs: 500,
        isAttached: () => false,
      }),
      /ENOENT/,
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
