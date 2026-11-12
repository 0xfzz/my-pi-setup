import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BUBBLY_INDICATOR_OPTIONS,
  BUBBLY_TEXT_INTERVAL_MS,
  BubblyWordAnimator,
} from "../lib/bubbly-spinner.ts";
import { publishWebUi } from "../lib/web-plugins/publisher.ts";

export default function bubblySpinnerExtension(pi: ExtensionAPI) {
  const animator = new BubblyWordAnimator();
  let waveTimer: NodeJS.Timeout | null = null;
  let activeContext: ExtensionContext | null = null;

  /**
   * Mirror the animated verb into the web's unified `ui.working.changed`
   * stream. Only the TUI line consumes `ctx.ui.setWorkingMessage`; the web
   * working line consumes `publishWebUi`, so bridged and in-process sessions
   * both show the bubbly verb instead of the default "pi is working…".
   */
  function postWorkingIndicator(): void {
    publishWebUi(pi, "ctx.ui.working", "ui.working.changed", {
      frames: BUBBLY_INDICATOR_OPTIONS.frames ?? null,
      intervalMs: BUBBLY_INDICATOR_OPTIONS.intervalMs ?? 80,
    });
  }

  function postWorkingMessage(message: string): void {
    publishWebUi(pi, "ctx.ui.working", "ui.working.changed", { message });
  }

  function renderCurrentFrame(ctx: ExtensionContext) {
    const text = animator.getCurrentText();
    ctx.ui.setWorkingMessage(text);
    postWorkingMessage(text);
  }

  function advanceFrame(ctx: ExtensionContext) {
    const text = animator.nextFrame();
    ctx.ui.setWorkingMessage(text);
    postWorkingMessage(text);
  }

  function startWaveAnimation(ctx: ExtensionContext) {
    stopWaveAnimation();
    activeContext = ctx;
    // Animate the bubble wave across the letters
    waveTimer = setInterval(() => {
      if (activeContext) {
        advanceFrame(activeContext);
      }
    }, BUBBLY_TEXT_INTERVAL_MS);
  }

  function stopWaveAnimation() {
    if (waveTimer) {
      clearInterval(waveTimer);
      waveTimer = null;
    }
    activeContext = null;
  }

  // Set the bubbly indicator and initial verb on startup, and mirror both into
  // the web's working line through the unified ui.working.changed stream.
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator(BUBBLY_INDICATOR_OPTIONS);
    postWorkingIndicator();
    renderCurrentFrame(ctx);
  });

  // Animate the bubble wave across the words while the agent is running
  pi.on("agent_start", async (_event, ctx) => {
    animator.advanceWord();
    renderCurrentFrame(ctx);
    startWaveAnimation(ctx);
  });

  // Switch to a fresh word immediately on each new turn
  pi.on("turn_start", async (_event, ctx) => {
    animator.advanceWord();
    renderCurrentFrame(ctx);
  });

  // Stop wave animation when agent finishes and stage next word
  pi.on("agent_end", async (_event, ctx) => {
    stopWaveAnimation();
    animator.advanceWord();
    renderCurrentFrame(ctx);
  });

  // Clean up all timers when session shuts down
  pi.on("session_shutdown", async () => {
    stopWaveAnimation();
  });

  // Informational / preview command
  pi.registerCommand("bubbly", {
    description: "Check status or preview next bubbly spinner verb: /bubbly [next]",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "next") {
        animator.advanceWord();
        renderCurrentFrame(ctx);
        ctx.ui.notify(`Advanced to next bubbly verb: ${animator.word}`, "info");
        return;
      }

      ctx.ui.notify(
        `Bubbly Spinner Active | Current: "${animator.word}" | Rotating pool: ${animator.totalVerbs} verbs | Wave interval: ${BUBBLY_TEXT_INTERVAL_MS}ms`,
        "info"
      );
    },
  });
}
