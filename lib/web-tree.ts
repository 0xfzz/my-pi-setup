/**
 * The session tree projection for the web's /tree picker.
 *
 * The DATA is pi's (SessionManager.getTree() — entries, branch structure,
 * labels, the leaf); the SHAPING mirrors pi's own TUI tree selector: the
 * default view hides settings/bookkeeping entries, messages render as
 * `role: snippet`, and the branch structure drives indentation. This module
 * owns only that shared projection — the extension builds it for bridged
 * sessions, the server for in-process ones, and the web renders the wire
 * shape (web/shared/tree.ts).
 */
import type { WebTreeNode } from "../web/shared/tree.ts";

export type { WebTreeNode };

/** The minimal tree shape pi's SessionManager.getTree() returns. */
export interface PiTreeNodeLike {
  entry: {
    id: string;
    type: string;
    timestamp?: string;
    message?: { role?: unknown; content?: unknown; command?: unknown };
    label?: unknown;
    summary?: unknown;
    name?: unknown;
    customType?: unknown;
    content?: unknown;
  };
  children?: unknown;
  label?: string;
}

const snippet = (content: unknown, limit = 120): string => {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (block): block is { type?: string; text?: string } =>
              typeof block === "object" && block !== null,
          )
          .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
          .join(" ")
          .trim()
      : "";
  return text.replace(/[\n\t]/g, " ").trim().slice(0, limit);
};

/** The entry types pi's default tree view hides (settings/bookkeeping). */
const isSettingsEntry = (entry: PiTreeNodeLike["entry"]): boolean =>
  entry.type === "label"
  || entry.type === "context_edit"
  || entry.type === "custom"
  || entry.type === "model_change"
  || entry.type === "thinking_level_change"
  || entry.type === "session_info";

const nodeLabel = (node: PiTreeNodeLike): { label: string; text?: string; role: WebTreeNode["role"] } => {
  const entry = node.entry;
  if (entry.type === "message") {
    const message = entry.message ?? {};
    const role = message.role;
    if (role === "user") {
      const text = snippet(message.content) || "(empty)";
      return { label: `user: ${text}`, text, role: "user" };
    }
    if (role === "assistant") {
      const text = snippet(message.content) || "(no content)";
      return { label: `assistant: ${text}`, text, role: "assistant" };
    }
    if (role === "bashExecution") {
      const text = snippet(message.command ?? "");
      return { label: `[bash]: ${text}`, text, role: "bash" };
    }
    if (role === "toolResult") {
      return { label: `tool result · ${entry.id.slice(0, 8)}`, role: "tool" };
    }
    return { label: `[${typeof role === "string" ? role : "message"}]`, role: "other" };
  }
  if (entry.type === "compaction") return { label: "compaction", role: "compaction" };
  if (entry.type === "branch_summary") {
    const text = snippet(entry.summary, 60);
    return { label: `branch summary: ${text}`, text, role: "summary" };
  }
  if (entry.type === "custom_message") {
    const text = snippet(entry.content, 60);
    return { label: `[${entry.customType ?? "custom"}]: ${text}`, text, role: "other" };
  }
  return { label: node.label ?? entry.type.replace(/_/g, " "), role: "other" };
};

/**
 * Flatten pi's tree into the web picker's nodes: pi's default filter (hide
 * settings entries), messages as `role: snippet`, branch-structure depth —
 * the same view pi's TUI tree selector opens with.
 */
export function buildWebTree(
  tree: readonly PiTreeNodeLike[],
  leafId: string | null,
): WebTreeNode[] {
  const nodes: WebTreeNode[] = [];
  // Iterative traversal: a long session is one deep chain (thousands of
  // entries), and a frame per entry overflows the stack — the walk holds
  // its own frames. The visited set guards malformed parent cycles.
  const visited = new Set<string>();
  const stack: Array<{ node: PiTreeNodeLike; depth: number; justBranched: boolean }> = [];
  for (let i = tree.length - 1; i >= 0; i--) {
    stack.push({ node: tree[i], depth: 0, justBranched: false });
  }
  while (stack.length > 0) {
    const { node: child, depth, justBranched } = stack.pop() as {
      node: PiTreeNodeLike;
      depth: number;
      justBranched: boolean;
    };
    const entry = child.entry;
    if (entry === undefined || typeof entry.id !== "string") continue;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    const grandChildren = Array.isArray(child.children)
      ? (child.children as readonly PiTreeNodeLike[])
      : [];
    if (!isSettingsEntry(entry)) {
      const { label, text, role } = nodeLabel(child);
      nodes.push({
        entryId: entry.id,
        label: child.label !== undefined && child.label !== "" ? `${child.label} — ${label}` : label,
        ...(text !== undefined ? { text } : {}),
        role,
        depth,
        isCurrent: entry.id === leafId,
        isBranch: grandChildren.length > 1,
        ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      });
    }
    // Depth follows the TUI's indent rule: a branch point (or the first
    // generation after one) shifts its children one level in; a linear
    // chain stays at its level.
    const childDepth = grandChildren.length > 1 || (justBranched && depth > 0)
      ? depth + 1
      : depth;
    // Push in reverse so the pop order matches the tree's order.
    for (let i = grandChildren.length - 1; i >= 0; i--) {
      stack.push({ node: grandChildren[i], depth: childDepth, justBranched: grandChildren.length > 1 });
    }
  }
  return nodes;
}
