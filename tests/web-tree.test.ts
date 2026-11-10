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

test("buildWebTree survives a very deep chain — no recursion, no stack overflow", () => {
  // A long working session is one deep linear chain (thousands of
  // entries); a frame-per-entry walk overflows the stack. 50k entries is
  // far past any real session.
  const depth = 50_000;
  const root: PiTreeNodeLike = messageNode("leaf", "user", "the newest");
  let current = root;
  for (let i = 0; i < depth; i++) {
    const next = messageNode(`e${i}`, "assistant", `reply ${i}`);
    current.children = [next];
    current = next;
  }
  const nodes = buildWebTree([root], "leaf");
  assert.equal(nodes.length, depth + 1);
  // The chain renders in order: the current node first, the tail last.
  assert.equal(nodes[0].entryId, "leaf");
  assert.equal(nodes[0].isCurrent, true);
  assert.equal(nodes[nodes.length - 1].entryId, "e49999");
  // A linear chain stays at depth 0 — no runaway indentation.
  assert.equal(nodes[nodes.length - 1].depth, 0);
});

test("buildWebTree breaks malformed parent cycles instead of looping forever", () => {
  // A corrupted parent chain (two entries claiming each other as
  // children) must terminate — the visited set cuts the cycle.
  const a: PiTreeNodeLike = messageNode("a", "user", "first");
  const b: PiTreeNodeLike = messageNode("b", "user", "second");
  a.children = [b];
  b.children = [a];
  const nodes = buildWebTree([a], null);
  assert.equal(nodes.length, 2);
  assert.deepEqual(
    nodes.map((node) => node.entryId),
    ["a", "b"],
  );
});

test("buildWebTree normalizes multi-line message content into the snippet", () => {
  const tree: PiTreeNodeLike[] = [
    messageNode("u1", "user", "line one\nline two\ttabbed"),
  ];
  const [node] = buildWebTree(tree, null);
  assert.equal(node.label, "user: line one line two tabbed");
});
