import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SDK_ROOT = join(process.cwd(), "packages", "pi-web-bridge");

test("a temp ESM project imports the SDK by package name without editing the repo", () => {
  const target = mkdtempSync(join(tmpdir(), "pi-web-bridge-consumer-"));
  try {
    const link = join(target, "node_modules", "@pi", "web-bridge");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(SDK_ROOT, link, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(target, "package.json"), `${JSON.stringify({
      name: "sdk-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`);
    writeFileSync(join(target, "entry.mjs"), [
      'import { MESSAGE_NAMES, webUiText } from "@pi/web-bridge";',
      'console.log(JSON.stringify({ messages: MESSAGE_NAMES.length, text: webUiText("\\u001b[31mready\\u001b[0m") }));',
    ].join("\n"));

    const stdout = execFileSync(process.execPath,
      ["--experimental-strip-types", "--no-warnings", "entry.mjs"],
      { cwd: target, encoding: "utf8" }).trim();
    const result = JSON.parse(stdout) as { messages: number; text: string };
    assert.ok(result.messages > 0);
    assert.equal(result.text, "ready");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
