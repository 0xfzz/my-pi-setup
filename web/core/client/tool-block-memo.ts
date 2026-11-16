// Keep a historical assistant message out of the redraw when an unrelated
// tool changes. `AssistantBlocks` receives the whole toolStatus and toolResults
// maps; every tool update allocates a new map, so React's default `memo`
// re-rendered every assistant message in the transcript. A message only reads
// the entries for the tool calls in its own blocks, so those are the only ones
// that can make it stale.
//
// Pure and DOM-free so the policy can be tested without React.

interface PropsLike<Block> {
  blocks: readonly Block[];
  live?: boolean;
  toolStatus: Record<string, unknown>;
  toolResults: Record<string, unknown>;
}

function toolCallIdOf(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const id = (block as { toolCallId?: unknown }).toolCallId;
  return typeof id === "string" ? id : undefined;
}

export function assistantBlocksPropsEqual<Block>(
  previous: PropsLike<Block>,
  next: PropsLike<Block>,
): boolean {
  if (previous.live !== next.live || previous.blocks.length !== next.blocks.length) return false;
  // Historical blocks keep their identity across renders. A new block means
  // new content (a streamed delta), so it must draw again.
  if (previous.blocks !== next.blocks && previous.blocks.some((block, index) => block !== next.blocks[index])) return false;
  return next.blocks.every((block) => {
    const id = toolCallIdOf(block);
    if (id === undefined || id === "") return true;
    return previous.toolStatus[id] === next.toolStatus[id]
      && previous.toolResults[id] === next.toolResults[id];
  });
}
