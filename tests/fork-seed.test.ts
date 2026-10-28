import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seededPrefixEntries,
  provenanceFromBranch,
  childContextState,
} from "../lib/subagent-context.ts";
import { patchedHerdrRoot } from "./fixtures/herdr-root.ts";

/**
 * The Herdr patch's seed is the producer; this package is the consumer. These
 * tests run the REAL `seedSubagentSessionFile` from the patched repository and
 * then read its output with the companion's readers, so the two halves of the
 * contract cannot drift apart silently.
 *
 * (Upstream's own suite covers the seed's internals; this covers the seam plus
 * the compaction case, which is where a copied branch can end up unreadable.)
 */

/**
 * The PATTERNED source, not merely any checkout.
 *
 * `fixtures/herdr-root.ts` resolves the vendored snapshot at
 * `vendor/pi-herdr-subagents` (or `HERDR_ROOT` when a live upstream checkout is
 * under test) and requires the provenance contract to be present in it, because
 * picking a directory that merely exists would silently test an unpatched seed.
 */
const HERDR_ROOT = patchedHerdrRoot();

const skip = HERDR_ROOT ? false : "pi-herdr-subagents repository not found";

async function seed() {
  return import(join(HERDR_ROOT!, "src", "session.ts"));
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "pi-fork-seed-"));
}

/** Write a parent session file and return its path. */
function parentFile(dir: string, entries: object[], id = "sess-parent"): string {
  const file = join(dir, "parent.jsonl");
  const header = { type: "session", id, version: 3, cwd: dir };
  writeFileSync(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const user = (id: string, parentId: string | null, text: string) => ({
  type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, parentId: string | null, text: string) => ({
  type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }] },
});

function readChild(file: string): { header: any; entries: any[] } {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { header: lines[0], entries: lines.slice(1) };
}

test("the companion reads what the Herdr seed wrote", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [user("u1", null, "Parent question"), assistant("a1", "u1", "Parent answer")]);
    const child = join(dir, "child.jsonl");

    const written = seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });
    const { header, entries } = readChild(child);

    // Producer and consumer must agree on every field the companion acts on.
    const read = provenanceFromBranch(entries);
    assert.ok(read, "the companion must find the provenance marker the seed wrote");
    assert.equal(read.mode, "fork");
    assert.equal(read.parentSession, parent);
    assert.equal(read.parentSessionId, written.parentSessionId);
    assert.equal(read.seededEntries, written.seededEntries);

    // The seed's copied prefix is exactly what the companion will strip.
    assert.equal(seededPrefixEntries(entries).length, 2);
    assert.equal(childContextState(entries, header).seeded, true);

    // Ids are preserved; only the header id is new, and it points at the source.
    assert.deepEqual(entries.slice(0, -1).map((e) => e.id), ["u1", "a1"]);
    assert.equal(header.parentSession, parent);
    assert.notEqual(header.id, "sess-parent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a compaction entry survives the copy and its firstKeptEntryId still resolves", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    // A compacted parent: the summary replaced earlier turns, and firstKeptEntryId
    // names an entry that must exist in the copy for Pi to rebuild context.
    const parent = parentFile(dir, [
      user("u1", null, "Old question"),
      assistant("a1", "u1", "Old answer"),
      {
        type: "compaction", id: "cmp-1", parentId: "a1",
        summary: "Earlier work was summarized.", firstKeptEntryId: "u2", tokensBefore: 9000,
      },
      user("u2", "cmp-1", "New question"),
      assistant("a2", "u2", "New answer"),
    ]);
    const child = join(dir, "child.jsonl");
    seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });

    const { entries } = readChild(child);
    const copiedIds = new Set(entries.map((e) => e.id));
    const compaction = entries.find((e) => e.type === "compaction");
    assert.ok(compaction, "the compaction entry must be copied");
    assert.equal(compaction.summary, "Earlier work was summarized.");
    assert.ok(
      copiedIds.has(compaction.firstKeptEntryId),
      "firstKeptEntryId must name an entry present in the child, or Pi cannot rebuild context",
    );
    assert.equal(copiedIds.has("u2"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fork of an assistant/toolResult leaf drops nothing", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Investigate"),
      assistant("a1", "u1", "Running the tool"),
      {
        type: "message", id: "tool-1", parentId: "a1",
        message: { role: "toolResult", toolCallId: "tc-1", toolName: "bash",
          content: [{ type: "text", text: "output" }] },
      },
    ]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });

    const { entries } = readChild(child);
    assert.deepEqual(entries.slice(0, -1).map((e) => e.id), ["u1", "a1", "tool-1"]);
    assert.equal(written.truncated, null, "an in-flight tool result is the parent's real work");
    assert.equal(written.seededEntries, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fork of a trailing user leaf retains that turn with latest user findings", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Question"),
      assistant("a1", "u1", "Answer"),
      user("u2", "a1", "Now spawn a worker with these latest findings"),
    ]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });

    const { entries } = readChild(child);
    assert.equal(entries.some((e) => e.id === "u2"), true, "latest user turn and findings must be retained");
    assert.deepEqual(entries.slice(0, -1).map((e) => e.id), ["u1", "a1", "u2"]);
    assert.equal(written.truncated, null);
    assert.equal(written.seededEntries, 3);
    assert.equal(written.parentLeafId, "u2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("active branch vs disk tail: seeds active branch when parentLeafId is explicit", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Initial task"),
      assistant("a1", "u1", "First answer"),
      assistant("a2", "a1", "Second active answer"),
      assistant("a_abandoned", "a1", "Dead end alternative"), // disk tail in file order!
    ]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: parent,
      childSessionFile: child,
      childCwd: dir,
      parentLeafId: "a2",
    });

    const { entries } = readChild(child);
    const copiedIds = entries.slice(0, -1).map((e) => e.id);
    assert.deepEqual(copiedIds, ["u1", "a1", "a2"]);
    assert.equal(entries.some((e) => e.id === "a_abandoned"), false);
    assert.equal(written.parentLeafId, "a2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid boundary error: throws when explicit parentLeafId does not exist", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Question"),
      assistant("a1", "u1", "Answer"),
    ]);
    const child = join(dir, "child.jsonl");

    assert.throws(
      () => {
        seedSubagentSessionFile({
          mode: "fork",
          parentSessionFile: parent,
          childSessionFile: child,
          childCwd: dir,
          parentLeafId: "nonexistent-leaf-xyz",
        });
      },
      /Invalid boundary: parent leaf "nonexistent-leaf-xyz" not found in session/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mid-tool-loop inheritance: preserves analysis text and makes outstanding tool calls provider-safe", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Find the bug"),
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Analysis: token validation bug found at line 42." },
            {
              type: "toolCall",
              id: "tc-mid",
              name: "agent_spawn",
              arguments: { task: "fix line 42" },
            },
          ],
        },
      },
    ]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: parent,
      childSessionFile: child,
      childCwd: dir,
    });

    const { entries } = readChild(child);
    const copied = entries.slice(0, -1);
    assert.equal(copied.length, 3, "expected u1, a1, and synthetic toolResult");
    assert.equal(copied[0].id, "u1");
    assert.equal(copied[1].id, "a1");

    // Analysis is not lost!
    assert.deepEqual(copied[1].message.content[0], {
      type: "text",
      text: "Analysis: token validation bug found at line 42.",
    });

    // Outstanding tool call has a synthesized toolResult
    const synthResult = copied[2];
    assert.equal(synthResult.type, "message");
    assert.equal(synthResult.message.role, "toolResult");
    assert.equal(synthResult.message.toolCallId, "tc-mid");
    assert.equal(synthResult.message.toolName, "agent_spawn");
    assert.equal(synthResult.parentId, "a1");
    assert.equal(synthResult.message.isError, true, "a placeholder must not claim the parent tool succeeded");
    assert.match(synthResult.message.content[0].text, /no result at fork time; not executed by this child/);
    assert.equal(Number.isFinite(synthResult.message.timestamp), true);

    // Provenance entry chains to the synthetic toolResult
    const provEntry = entries[entries.length - 1];
    assert.equal(provEntry.parentId, synthResult.id);

    assert.equal(written.seededEntries, 3);
    assert.equal(written.truncated, null);
    assert.equal(written.parentLeafId, "a1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiple outstanding calls remain reachable when real results and metadata follow", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const calls = ["missing-1", "missing-2", "resolved"].map(id => ({
      type: "toolCall", id, name: "bash", arguments: { command: "true" },
    }));
    const parent = parentFile(dir, [
      user("u1", null, "Delegate after inspection"),
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [
        { type: "text", text: "Keep these findings" }, ...calls,
      ] } },
      { type: "message", id: "r1", parentId: "a1", message: {
        role: "toolResult", toolCallId: "resolved", toolName: "bash",
        content: [{ type: "text", text: "Real output" }],
      } },
      { type: "custom", id: "metadata", parentId: "r1", customType: "checkpoint", data: {} },
    ]);
    const before = readFileSync(parent, "utf8");
    const child = join(dir, "child.jsonl");
    seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir });
    const { entries } = readChild(child);
    assert.deepEqual(entries.filter(e => e.message?.role === "toolResult").map(e => e.message.toolCallId),
      ["missing-1", "missing-2", "resolved"]);
    for (let i = 1; i < entries.length; i++) {
      assert.equal(entries[i].parentId, entries[i - 1].id, "every seed entry must be reachable from the child leaf");
    }
    const byId = new Map(entries.map(e => [e.id, e]));
    const branch: any[] = [];
    let cursor = entries.at(-1);
    while (cursor) { branch.unshift(cursor); cursor = byId.get(cursor.parentId); }
    assert.equal(branch.length, entries.length, "active-branch traversal must retain synthetic results too");
    assert.equal(entries.find(e => e.id === "r1").message.content[0].text, "Real output");
    assert.equal(readFileSync(parent, "utf8"), before, "repair must only change the child copy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit null leaf seeds an empty branch, not the disk tail", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [user("u1", null, "Inactive disk history")]);
    const child = join(dir, "child.jsonl");
    const provenance = seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent,
      childSessionFile: child, childCwd: dir, parentLeafId: null });
    const { entries } = readChild(child);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].parentId, null);
    assert.equal(provenance.seededEntries, 0);
    assert.equal(provenance.parentLeafId, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provenance: full metadata contract verified on fork seed", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [
      user("u1", null, "Task instruction"),
      assistant("a1", "u1", "Working on it"),
    ], "sess-parent-prov-123");
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: parent,
      childSessionFile: child,
      childCwd: dir,
      parentLeafId: "a1",
    });

    const { entries } = readChild(child);
    const prov = provenanceFromBranch(entries);
    assert.ok(prov, "provenance record must exist");
    assert.equal(prov.version, 1);
    assert.equal(prov.mode, "fork");
    assert.equal(prov.parentSession, parent);
    assert.equal(prov.parentSessionId, "sess-parent-prov-123");
    assert.equal(prov.parentLeafId, "a1");
    assert.equal(prov.seededEntries, 2);
    assert.ok(prov.seededChars > 0, "seededChars must be positive");
    assert.ok(prov.estimatedTokens > 0, "estimatedTokens must be positive");
    assert.equal(prov.truncated, null);
    assert.equal(prov.briefSource, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("secrets are redacted in the copy while the parent file is untouched", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const parent = parentFile(dir, [user("u1", null, `Use ${secret} to call the API`), assistant("a1", "u1", "Noted")]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });

    const childRaw = readFileSync(child, "utf8");
    assert.equal(childRaw.includes(secret), false);
    assert.match(childRaw, /\[REDACTED by fork seed\]/);
    assert.equal(written.secretsRedacted, 1);
    // Redaction is a copy-time transform: the parent's own record is evidence.
    assert.equal(readFileSync(parent, "utf8").includes(secret), true);
    // Non-secret text survives intact.
    assert.match(childRaw, /to call the API/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a digest seed copies no entries but still records its parent", { skip }, async () => {
  const dir = workspace();
  try {
    const { seedSubagentSessionFile } = await seed();
    const parent = parentFile(dir, [user("u1", null, "Question"), assistant("a1", "u1", "Answer")]);
    const child = join(dir, "child.jsonl");
    const written = seedSubagentSessionFile({
      mode: "digest", parentSessionFile: parent, childSessionFile: child, childCwd: dir,
    });

    const { header, entries } = readChild(child);
    assert.equal(entries.filter((e) => e.type === "message").length, 0);
    assert.equal(written.seededEntries, 0);
    assert.equal(written.briefSource, "vcc");
    assert.equal(provenanceFromBranch(entries)?.mode, "digest");
    // A digest child is a child, but it inherited no entries: never strip a prefix.
    assert.equal(seededPrefixEntries(entries).length, 0);
    assert.equal(childContextState(entries, header).seeded, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
