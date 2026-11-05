import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BUBBLY_INDICATOR_OPTIONS,
  BUBBLY_TEXT_INTERVAL_MS,
  BubblyWordAnimator,
} from "../lib/bubbly-spinner.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";

export default function bubblySpinnerExtension(pi: ExtensionAPI) {
  const animator = new BubblyWordAnimator();
  let waveTimer: NodeJS.Timeout | null = null;
  let activeContext: ExtensionContext | null = null;
  let isWorking = false;

  function publishStatusView(working: boolean) {
    isWorking = working;
    try {
      publishWebView(pi, "bubbly-spinner", {
        type: "status",
        tone: working ? "accent" : "neutral",
        text: `${animator.word}...`,
      });
    } catch {
      // Guarded: never touch TUI render path or throw into caller
    }
  }

  function renderCurrentFrame(ctx: ExtensionContext) {
    ctx.ui.setWorkingMessage(animator.getCurrentText());
  }

  function advanceFrame(ctx: ExtensionContext) {
    ctx.ui.setWorkingMessage(animator.nextFrame());
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

  // Set the bubbly indicator and initial verb on startup
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator(BUBBLY_INDICATOR_OPTIONS);
    renderCurrentFrame(ctx);
    publishStatusView(false);
  });

  // Animate the bubble wave across the words while the agent is running
  pi.on("agent_start", async (_event, ctx) => {
    animator.advanceWord();
    renderCurrentFrame(ctx);
    startWaveAnimation(ctx);
    publishStatusView(true);
  });

  // Switch to a fresh word immediately on each new turn
  pi.on("turn_start", async (_event, ctx) => {
    animator.advanceWord();
    renderCurrentFrame(ctx);
    publishStatusView(true);
  });

  // Stop wave animation when agent finishes and stage next word
  pi.on("agent_end", async (_event, ctx) => {
    stopWaveAnimation();
    animator.advanceWord();
    renderCurrentFrame(ctx);
    publishStatusView(false);
  });

  // Clean up all timers when session shuts down
  pi.on("session_shutdown", async () => {
    stopWaveAnimation();
    publishStatusView(false);
  });

  // Informational / preview command
  pi.registerCommand("bubbly", {
    description: "Check status or preview next bubbly spinner verb: /bubbly [next]",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "next") {
        animator.advanceWord();
        renderCurrentFrame(ctx);
        publishStatusView(isWorking);
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
