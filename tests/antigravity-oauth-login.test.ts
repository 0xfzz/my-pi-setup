// Regression: `/login antigravity` crashed Pi with "OAuth callback cancelled" as an
// uncaught exception. loginAntigravity() starts the callback server, then fails
// before it awaits the callback (here: the callbacks object has no onAuth). Its
// finally block cancels the pending callback promise, and nothing had attached a
// handler to it yet, so Node reported an unhandled rejection that took Pi down.
import test from "node:test";
import assert from "node:assert/strict";
import { loginAntigravity } from "../vendor/antigravity/auth/oauth.ts";
import { loginCallbacks } from "../extensions/antigravity-accounts.ts";

test("a login that fails before awaiting the callback reports only its own error", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(loginAntigravity({} as never), TypeError);
    // Give Node a turn to report any rejection that nobody handled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the login adapter shows the sign-in URL and treats a dismissed prompt as cancelled", async () => {
  const notes: string[] = [];
  const ui = {
    notify: (message: string) => { notes.push(message); },
    input: async () => undefined,
    select: async () => undefined,
  };
  const callbacks = loginCallbacks(ui as never, new AbortController().signal);

  callbacks.onAuth({ url: "https://accounts.example/auth?x=1", instructions: "Sign in." });
  assert.match(notes[0] ?? "", /https:\/\/accounts\.example\/auth\?x=1/);

  await assert.rejects(callbacks.onPrompt({ message: "Paste the callback URL" }), /Login cancelled/);
});
