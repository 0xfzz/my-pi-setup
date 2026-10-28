import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeClipboardFailure, parseUriList, readClipboard, waylandDisplay } from "../lib/clipboard.ts";

const noFiles = (): string[] => [];

function harness(options: {
  env?: Record<string, string>;
  exists?: (path: string) => boolean;
  readdir?: (path: string) => string[];
  respond: (command: string, args: string[], env: NodeJS.ProcessEnv) => string | undefined;
}) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const run = async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const env = opts?.env ?? {};
    calls.push({ command, args, env });
    const value = options.respond(command, args, env);
    return value === undefined ? undefined : Buffer.from(value);
  };
  return {
    calls,
    read: () => readClipboard({
      run,
      env: options.env,
      exists: options.exists ?? (() => false),
      readdir: options.readdir ?? noFiles,
      platform: "linux",
    }),
  };
}

test("a Wayland session reads the clipboard without needing DISPLAY", async () => {
  const h = harness({
    env: { WAYLAND_DISPLAY: "wayland-1" },
    respond: (command, args) => (command === "wl-paste" && !args.includes("text/uri-list") && !args.includes("text/plain;charset=utf-8") ? "hello from wayland" : undefined),
  });
  const read = await h.read();
  assert.equal(read?.text, "hello from wayland");
  assert.equal(h.calls[0]?.command, "wl-paste");
  assert.equal(h.calls[0]?.env.WAYLAND_DISPLAY, "wayland-1");
});

test("an unexported Wayland socket is discovered instead of skipped", async () => {
  const h = harness({
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    exists: path => path === "/run/user/1000/wayland-0",
    respond: (command, args) => (command === "wl-paste" && !args.includes("text/uri-list") && !args.includes("charset") ? "found socket" : undefined),
  });
  const read = await h.read();
  assert.equal(read?.text, "found socket");
  assert.equal(h.calls[0]?.env.WAYLAND_DISPLAY, "wayland-0", "the socket is exported to the helper");
});

test("X11 is tried when no Wayland socket exists, with explicit targets", async () => {
  const h = harness({
    env: { DISPLAY: ":0" },
    respond: (command, args, env) => {
      if (env.WAYLAND_DISPLAY) return undefined;
      // `STRING` is what pi asks for and what many toolkits refuse to offer.
      if (command === "xclip" && args.at(-1) === "UTF8_STRING") return "x11 text";
      return undefined;
    },
  });
  const read = await h.read();
  assert.equal(read?.text, "x11 text");
  const targets = h.calls.filter(call => call.command === "xclip").map(call => call.args.at(-1));
  assert.deepEqual(targets.slice(0, 2), ["text/uri-list", "UTF8_STRING"], "uri-list first, then UTF8_STRING before STRING");
});

test("the tmux buffer is a last-resort text source", async () => {
  const h = harness({
    env: { TMUX: "/tmp/tmux-1000/default,1,0" },
    respond: (command, args) => (command === "tmux" && args[0] === "save-buffer" ? "from tmux" : undefined),
  });
  assert.equal((await h.read())?.text, "from tmux");
});

test("file copies win over text so the model gets a path it can act on", async () => {
  const h = harness({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    respond: (command, args) =>
      command === "wl-paste" && args.includes("text/uri-list")
        ? "file:///home/u/My%20Docs/a.txt\r\nfile:///home/u/b.txt\r\n"
        : command === "wl-paste" ? "plain text" : undefined,
  });
  const read = await h.read();
  assert.deepEqual(read?.files, ["/home/u/My Docs/a.txt", "/home/u/b.txt"]);
  assert.equal(read?.text, undefined);
});

test("an image-only clipboard still pastes", async () => {
  const h = harness({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    respond: (command, args) => (command === "wl-paste" && args.includes("image/png") ? "\u0089PNG" : undefined),
  });
  const read = await h.read();
  assert.equal(read?.image?.mimeType, "image/png");
  assert.ok(read?.image?.bytes.length, "the image bytes are returned, not decoded as text");
  assert.equal(read?.text, undefined, "an image-only clipboard has no text");
});

test("nothing readable returns undefined but explains what it tried", async () => {
  const h = harness({ env: {}, respond: () => undefined });
  const read = await h.read();
  assert.equal(read, undefined);
  const message = describeClipboardFailure(read, { terminalPasteKey: "Ctrl+Shift+V" });
  assert.match(message, /nothing readable/i);
  assert.match(message, /Ctrl\+Shift\+V/, "it names the terminal's own paste as the workaround");
});

test("the failure message lists attempted backends when there were some", async () => {
  const h = harness({ env: { WAYLAND_DISPLAY: "wayland-0" }, respond: () => undefined });
  await h.read();
  const read = harness({ env: {}, respond: () => undefined });
  await read.read();
  const message = describeClipboardFailure({ attempts: ["wl-paste --no-newline", "xclip -selection clipboard -out"] }, { terminalPasteKey: "Ctrl+Shift+V" });
  assert.match(message, /wl-paste/);
});

test("non-Linux platforms delegate to pi instead of guessing", async () => {
  const read = await readClipboard({ run: async () => Buffer.from("x"), platform: "darwin" });
  assert.equal(read, undefined);
});

test("helper failures are skipped, not fatal", async () => {
  const h = harness({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    respond: (command, args) => {
      if (command === "wl-paste") throw new Error("no wayland access");
      if (command === "xclip" && args.at(-1) === "UTF8_STRING") return "fallback";
      return undefined;
    },
  });
  assert.equal((await h.read())?.text, "fallback");
});

test("uri-list parsing ignores comments, blanks and non-file schemes", () => {
  assert.deepEqual(parseUriList("# comment\n\nfile:///a/b.txt\nhttps://example.com/x\nfile:///c.txt\n"), ["/a/b.txt", "/c.txt"]);
});

test("socket discovery prefers the env, then wayland-0, then any socket", () => {
  assert.equal(waylandDisplay({ WAYLAND_DISPLAY: "wayland-9" }, () => false, () => []), "wayland-9");
  assert.equal(waylandDisplay({ XDG_RUNTIME_DIR: "/r" }, path => path === "/r/wayland-0", () => []), "wayland-0");
  assert.equal(waylandDisplay({ XDG_RUNTIME_DIR: "/r" }, () => false, () => ["wayland-2", "wayland-1.lock", "wayland-1"]), "wayland-1");
  assert.equal(waylandDisplay({}, () => false, () => []), undefined);
});

test("the real filesystem defaults discover a socket the env does not export", async () => {
  // Regression: the discovery pass had no default `exists`, so production sessions
  // silently skipped Wayland whenever WAYLAND_DISPLAY was missing — the exact case
  // this extension exists for. Only `run` is faked here.
  const runtime = mkdtempSync(join(tmpdir(), "clip-runtime-"));
  writeFileSync(join(runtime, "wayland-0"), "");
  try {
    let sawEnv: NodeJS.ProcessEnv | undefined;
    const read = await readClipboard({
      run: async (command, args, options) => {
        sawEnv = options?.env;
        return command === "wl-paste" && !args.includes("charset") && !args.includes("text/uri-list")
          ? Buffer.from("discovered")
          : undefined;
      },
      env: { XDG_RUNTIME_DIR: runtime },
      platform: "linux",
    });
    assert.equal(read?.text, "discovered");
    assert.equal(sawEnv?.WAYLAND_DISPLAY, "wayland-0");
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});
