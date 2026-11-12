/**
 * The session tree wire contract: the /tree endpoint's response shape.
 *
 * pi owns the DATA (its getTree); lib/web-tree.ts owns the projection
 * (the TUI selector's shaping); the client owns only this shape.
 */

/** One pickable point in the tree, as the web picker renders it. */
export interface WebTreeNode {
  entryId: string;
  /** The display label: `role: snippet` for messages, the entry's own text otherwise. */
  label: string;
  /** The message snippet alone (the label minus the role prefix), for tag rendering. */
  text?: string;
  /** The node's role, for coloring and filtering like the TUI's selector. */
  role: "user" | "assistant" | "tool" | "bash" | "compaction" | "summary" | "other";
  /** Branch depth (0 at the root chain; +1 past each branch point). */
  depth: number;
  /** This node is the session's current leaf. */
  isCurrent: boolean;
  /** The tree branches here (2+ children) — a real fork in history. */
  isBranch: boolean;
  timestamp?: string;
}
