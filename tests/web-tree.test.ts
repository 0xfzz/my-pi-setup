import test from "node:test";
import assert from "node:assert/strict";
import { buildWebTree, type PiTreeNodeLike } from "../lib/web-tree.ts";

/** A message entry node, the shape pi's getTree() returns. */
const messageNode = (
  id: string,
  role: string,
  text: string,
  children: PiTreeNodeLike[] = [],
): PiTreeNodeLike => ({
  entry: {
    id,
    type: "message",
    timestamp: "2026-11-10T00:00:00Z",
    message: { role, content: [{ type: "text", text }] },
  },
  children,
});

test("buildWebTree hides settings entries and labels messages as the TUI does", () => {
  const tree: PiTreeNodeLike[] = [
    // Settings entries are invisible in the default view.
    { entry: { id: "m1", type: "model_change" }, children: [] },
    { entry: { id: "t1", type: "thinking_level_change" }, children: [] },
    messageNode("u1", "user", "hello there", [
      messageNode("a1", "assistant", "hi back"),
      messageNode("tr1", "toolResult", "file.txt"),
    ]),
  ];
  const nodes = buildWebTree(tree, "a1");
  assert.deepEqual(
    nodes.map((node) => node.label),
    ["user: hello there", "assistant: hi back", "tool result · tr1"],
  );
  // The assistant message is the current leaf.
  assert.deepEqual(
    nodes.map((node) => node.isCurrent),
    [false, true, false],
  );
});

test("buildWebTree indents at branch points, keeps linear chains flat", () => {
  // A branch: one user message with two assistant replies.
  const tree: PiTreeNodeLike[] = [
    messageNode("u1", "user", "pick a path", [
      messageNode("a1", "assistant", "first branch", [
        messageNode("a1b", "assistant", "first continues"),
        messageNode("a1c", "assistant", "first also continues"),
      ]),
      messageNode("a2", "assistant", "second branch"),
    ]),
  ];
  const nodes = buildWebTree(tree, "a2");
  // Root chain at 0; a branch point's children shift one level in — BOTH
  // children of the same branch share their depth, like the TUI's indents.
  assert.deepEqual(
    nodes.map((node) => node.depth),
    [0, 1, 2, 2, 1],
  );
  assert.deepEqual(
    nodes.map((node) => node.isBranch),
    [true, true, false, false, false],
  );
});

test("buildWebTree labels compaction, summaries and custom messages", () => {
  const tree: PiTreeNodeLike[] = [
    { entry: { id: "c1", type: "compaction" }, children: [] },
    { entry: { id: "b1", type: "branch_summary", summary: "the earlier work" }, children: [] },
    { entry: { id: "x1", type: "custom_message", customType: "note", content: "a side note" }, children: [] },
  ];
  const nodes = buildWebTree(tree, null);
  assert.deepEqual(
    nodes.map((node) => node.label),
    ["compaction", "branch summary: the earlier work", "[note]: a side note"],
  );
});

test("buildWebTree carries a node's label and the entry timestamp", () => {
  const tree: PiTreeNodeLike[] = [
    { entry: { id: "u1", type: "message", timestamp: "2026-11-10T09:00:00Z", message: { role: "user", content: "hi" } }, label: "the good branch", children: [] },
  ];
  const [node] = buildWebTree(tree, null);
  assert.equal(node.label, "the good branch — user: hi");
  assert.equal(node.timestamp, "2026-11-10T09:00:00Z");
});

test("buildWebTree normalizes multi-line message content into the snippet", () => {
  const tree: PiTreeNodeLike[] = [
    messageNode("u1", "user", "line one\nline two\ttabbed"),
  ];
  const [node] = buildWebTree(tree, null);
  assert.equal(node.label, "user: line one line two tabbed");
});
