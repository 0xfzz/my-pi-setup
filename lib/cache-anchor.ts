// Keep the prompt-cache breakpoints on the parts of a request that survive.
//
// A provider caches a prompt prefix only where a `cache_control` marker sits,
// and Anthropic allows four markers per request. Pi spends them on the system
// prompt, the last tool definition and the last block of the final message.
// Several extensions here append request-local text at the tail (the artifact
// catalog, checkpoint snapshots, the todo line, the mode reminder). That text
// becomes the final block, so the only conversation-level marker lands on
// something the next request no longer sends: the entry it writes can never be
// read back, and every request re-writes the whole conversation (observed:
// 24k read, 137k written, per call).
//
// `markVolatileTail` names that text. `planCacheBreakpoints` then spends the
// four markers on four lifetimes:
//
//   1. the system prompt        — stable for the session
//   2. the last tool            — stable until the tool set changes
//   3. the last real prompt     — a position that recurs in every request of a
//                                 turn, so it is an exact prefix hit however
//                                 much the turn appends
//   4. the last stable block    — absorbs the in-turn delta
//
// Marker 3 is what makes the cache hold. Marker 4 alone reaches back only about
// twenty blocks, so a turn that appends more than that (roughly nine parallel
// tool calls) could still miss its own last entry; 3 cannot be outrun.

const REGISTRY = Symbol.for("pi-workflow-extensions.volatile-tail");
const LIMIT = 64;
/** Anthropic's cap on `cache_control` markers in one request. */
const MAX_MARKERS = 4;

type Registry = { texts: Set<string> };

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[REGISTRY] ??= { texts: new Set<string>() });
}

/** Declare text an extension appends to the end of a request and will not resend as-is. */
export function markVolatileTail(text: string): string {
  const { texts } = registry();
  texts.delete(text);
  texts.add(text);
  // Oldest first: a Set iterates in insertion order.
  while (texts.size > LIMIT) texts.delete(texts.values().next().value as string);
  return text;
}

type Block = { type?: string; text?: string; cache_control?: unknown } & Record<string, unknown>;
type Message = { role?: string; content?: unknown };

/** Block kinds a provider accepts `cache_control` on. */
const ANCHORABLE = new Set(["text", "image", "tool_use", "tool_result", "document"]);

const isBlock = (value: unknown): value is Block => typeof value === "object" && value !== null;

const blocksOf = (content: unknown): Block[] | undefined =>
  Array.isArray(content) ? content.filter(isBlock) : undefined;

const isVolatileText = (block: Block, texts: Set<string>): boolean =>
  block.type === "text" && typeof block.text === "string" && texts.has(block.text);

export interface CachePlan {
  /** Markers on the request after planning. */
  placed: number;
  /** The last real prompt carries a marker. */
  pin: boolean;
  /** The last stable block of the conversation carries a marker. */
  rolling: boolean;
  /** Redundant markers removed: a second system block costs no information. */
  dropped: number;
  /** Why a message-level marker was not placed. */
  skipped?: "no markers" | "marker budget" | "no prompt" | "no stable block";
}

let lastPlan: CachePlan | undefined;

/** The most recent plan, for reporting. */
export const lastCachePlan = (): CachePlan | undefined => lastPlan;

/** Forget the last plan (a new session starts from no evidence). */
export function resetCachePlan(): void {
  lastPlan = undefined;
}

const record = (plan: CachePlan): CachePlan => (lastPlan = plan);

/** A prompt: the marker position that reappears unchanged in every later request of a turn. */
interface PromptSpot {
  message: Message;
  /** Set when the prompt is one block; absent when the whole content is one string. */
  block?: Block;
}

/**
 * The last real prompt before the tail, if the request still carries one.
 * A request-local tail is never a prompt, and neither is a message that only
 * carries tool results (those move forward on every call).
 */
function findPrompt(messages: Message[], texts: Set<string>): PromptSpot | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      if (message.content.trim().length === 0 || texts.has(message.content)) continue;
      return { message };
    }
    const blocks = blocksOf(message.content);
    if (!blocks || blocks.length === 0) continue;
    if (blocks.some((block) => block.type === "tool_result")) continue;
    const stable = blocks.filter(
      (block) => (block.type === "text" || block.type === "image") && !isVolatileText(block, texts),
    );
    const block = stable[stable.length - 1];
    if (block) return { message, block };
  }
  return undefined;
}

/** The last block that is not request-local text: where the conversation really ends. */
function findRolling(messages: Message[], texts: Set<string>): Block | undefined {
  scan: for (let index = messages.length - 1; index >= 0; index--) {
    const blocks = blocksOf(messages[index]?.content);
    if (!blocks) break;
    for (let position = blocks.length - 1; position >= 0; position--) {
      const block = blocks[position];
      if (!block) continue;
      if (isVolatileText(block, texts)) continue;
      if (block.type && ANCHORABLE.has(block.type)) return block;
      break scan;
    }
  }
  return undefined;
}

/** Convert a one-string prompt so a marker can sit on it, as Pi does for the last message. */
function markPrompt(spot: PromptSpot, marker: unknown): void {
  if (spot.block) {
    spot.block.cache_control = marker;
    return;
  }
  spot.message.content = [{ type: "text", text: spot.message.content as string, cache_control: marker }];
}

/**
 * Place the four breakpoints on the payload. Mutates it in place and returns the
 * plan. A request with no marker anywhere (caching off, or a payload whose shape
 * is not Anthropic's) is left exactly as it arrived: this never opts a request
 * into caching that Pi did not ask for.
 */
export function planCacheBreakpoints(payload: unknown): CachePlan {
  const body = payload as { system?: unknown; tools?: unknown; messages?: unknown } | null | undefined;
  const messages = body?.messages;
  if (!body || !Array.isArray(messages) || messages.length === 0) {
    return record({ placed: 0, pin: false, rolling: false, dropped: 0, skipped: "no markers" });
  }

  const system = blocksOf(body.system) ?? [];
  const tools = Array.isArray(body.tools) ? body.tools.filter(isBlock) : [];
  const marker =
    [...system, ...tools].find((block) => block.cache_control !== undefined)?.cache_control ??
    messages
      .flatMap((message) => blocksOf((message as Message).content) ?? [])
      .find((block) => block.cache_control !== undefined)?.cache_control;
  if (marker === undefined) {
    return record({ placed: 0, pin: false, rolling: false, dropped: 0, skipped: "no markers" });
  }

  // One system marker is enough: an OAuth request carries two (the "You are
  // Claude Code" identity plus Pi's prompt) and the identity prefix is a subset
  // of the next block's, so its marker only spends budget.
  const markedSystem = system.filter((block) => block.cache_control !== undefined);
  for (const block of markedSystem.slice(0, Math.max(0, markedSystem.length - 1))) {
    delete block.cache_control;
  }
  const systemMarkers = Math.min(markedSystem.length, 1);
  const toolMarkers = tools.filter((block) => block.cache_control !== undefined).length;
  const budget = Math.max(0, MAX_MARKERS - systemMarkers - toolMarkers);

  const texts = registry().texts;
  const prompt = findPrompt(messages as Message[], texts);
  const canPin = prompt !== undefined && budget >= 1;
  let placedMessages = 0;
  let pin = false;
  let rollingMarked = false;
  // An existing marker is only worth removing when something better replaces it.
  const strip = (): void => {
    for (const message of messages) {
      for (const block of blocksOf((message as Message).content) ?? []) {
        if (block.cache_control !== undefined) delete block.cache_control;
      }
    }
  };

  if (canPin) {
    // The prompt goes first: it is the marker that in-turn growth cannot outrun.
    strip();
    markPrompt(prompt, marker);
    placedMessages = 1;
    pin = true;
    const rolling = findRolling(messages as Message[], texts);
    if (rolling === prompt.block) rollingMarked = true;
    else if (rolling && placedMessages < budget) {
      rolling.cache_control = marker;
      placedMessages++;
      rollingMarked = true;
    }
  } else {
    // No prompt to pin (a continuation, or the whole message budget is spent
    // above): fall back to the rolling anchor alone.
    const rolling = findRolling(messages as Message[], texts);
    if (rolling && budget >= 1) {
      strip();
      rolling.cache_control = marker;
      placedMessages = 1;
      rollingMarked = true;
    }
  }

  let skipped: CachePlan["skipped"];
  if (!pin) skipped = budget < 1 ? "marker budget" : "no prompt";
  else if (!rollingMarked) skipped = "marker budget";

  return record({
    placed: systemMarkers + toolMarkers + placedMessages,
    pin,
    rolling: rollingMarked,
    dropped: Math.max(0, markedSystem.length - 1),
    skipped,
  });
}
