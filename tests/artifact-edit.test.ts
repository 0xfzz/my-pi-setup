import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import artifactsExtension, { publishChildSnapshot, readSidecarArtifact } from "../extensions/artifacts.ts";
import {
  applyArtifactEdit,
  artifactLineCount,
  renderArtifactSlice,
  searchArtifactText,
  sliceArtifactContent,
  type Artifact,
} from "../lib/artifact-state.ts";

function harness(opts: { isChild?: boolean; childSession?: string; childRun?: string; childName?: string; childScope?: string } = {}) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const entries: any[] = [];

  const pi: any = {
    on(name: string, fn: Function) {
      handlers.set(name, [...handlers.get(name) ?? [], fn]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data, timestamp: new Date().toISOString() });
    },
  };

  const context: any = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: { addAutocompleteProvider() {}, setWidget() {}, notify() {} },
  };

  const origEnv = { ...process.env };
  const origArgv = process.argv;
  if (opts.isChild) {
    const session = opts.childSession || "/tmp/child.jsonl";
    process.env.PI_SUBAGENT_SESSION = session;
    process.env.PI_SUBAGENT_ID = opts.childRun || "child-run-1";
    process.env.PI_SUBAGENT_NAME = opts.childName || "Worker";
    if (opts.childScope) process.env.PI_SUBAGENT_SCOPE = opts.childScope;
    else delete process.env.PI_SUBAGENT_SCOPE;
    // A real Herdr child is launched as `pi --session <its own file>`; that argument
    // is what ties the inherited env to this process.
    process.argv = [...process.argv, "--session", session];
  } else {
    delete process.env.PI_SUBAGENT_SESSION;
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_SCOPE;
  }

  artifactsExtension(pi);

  process.env = origEnv;
  process.argv = origArgv;

  const call = (name: string, args: any) =>
    tools.get(name).execute(`call-${name}`, args, undefined, undefined, context);

  return { context, tools, entries, call, emit: async (name: string, event: any = {}) => {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = (await fn(event, context)) ?? result;
    return result;
  } };
}

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "doc",
  title: "Doc",
  type: "spec",
  content: "alpha\nbeta\ngamma\ndelta",
  version: 1,
  createdBy: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tags: [],
  ...over,
});

// ── Pure primitives ──

test("sliceArtifactContent selects 1-based ranges and reports whether more exists", () => {
  const content = "one\ntwo\nthree\nfour\nfive";

  const head = sliceArtifactContent(content, 1, 2);
  assert.deepEqual(head.lines, ["one", "two"]);
  assert.equal(head.startLine, 1);
  assert.equal(head.endLine, 2);
  assert.equal(head.totalLines, 5);
  assert.equal(head.hasBefore, false);
  assert.equal(head.hasAfter, true);

  const middle = sliceArtifactContent(content, 3, 2);
  assert.deepEqual(middle.lines, ["three", "four"]);
  assert.equal(middle.hasBefore, true);
  assert.equal(middle.hasAfter, true);

  // limit past the end clamps instead of padding.
  const tail = sliceArtifactContent(content, 4, 99);
  assert.deepEqual(tail.lines, ["four", "five"]);
  assert.equal(tail.endLine, 5);
  assert.equal(tail.hasAfter, false);

  // No limit reads to the end.
  assert.equal(sliceArtifactContent(content, 2).lines.length, 4);
  assert.equal(sliceArtifactContent(content).lines.length, 5);

  // Offset past the end yields an empty slice, flagged rather than padding.
  const past = sliceArtifactContent(content, 99);
  assert.deepEqual(past.lines, []);
  assert.equal(past.startLine, 6, "start clamps to totalLines + 1");
});

test("renderArtifactSlice writes a 1-based gutter the caller can cite back", () => {
  const slice = sliceArtifactContent("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk", 9, 3);
  const rendered = renderArtifactSlice(slice);
  const lines = rendered.split("\n");
  assert.equal(lines[0], " 9│ i");
  assert.equal(lines[1], "10│ j", "gutter widens to the largest line number");
  assert.equal(lines[2], "11│ k");

  // lineNumbers:false is the mode used when copying text into `oldString`.
  assert.equal(renderArtifactSlice(slice, { lineNumbers: false }), "i\nj\nk");
  assert.equal(renderArtifactSlice(sliceArtifactContent("a", 5)), "(empty range)");
});

test("searchArtifactText reports artifact, line and column, literal by default", () => {
  const docs = [art({ id: "a", content: "Retry policy\nbackoff\nRetry limit" }), art({ id: "b", content: "no match here" })];

  const hits = searchArtifactText(docs, "Retry");
  assert.equal(hits.matches.length, 2, "case-insensitive by default");
  assert.deepEqual(hits.matches.map(m => [m.artifactId, m.line, m.column]), [["a", 1, 1], ["a", 3, 1]]);
  assert.equal(hits.artifactsSearched, 2, "searched both artifacts");

  const context = searchArtifactText(docs, "backoff", { contextLines: 1 });
  assert.deepEqual(context.matches[0].before, ["Retry policy"]);
  assert.deepEqual(context.matches[0].after, ["Retry limit"]);

  assert.equal(searchArtifactText(docs, "retry", { caseSensitive: true }).matches.length, 0);
  assert.equal(searchArtifactText(docs, "x\\d", { regex: true }).matches.length, 0);

  // A literal query is escaped, so regex metacharacters are not interpreted.
  const literalParen = [art({ id: "p", content: "call f(x) now" })];
  assert.equal(searchArtifactText(literalParen, "f(x)").matches.length, 1);
  assert.match(searchArtifactText(literalParen, "f(x)").matches[0].text, /call f\(x\) now/);

  // type filter narrows which artifacts are searched.
  assert.equal(searchArtifactText([...docs, art({ id: "c", type: "plan", content: "Retry" })], "Retry", { type: "plan" }).matches.length, 1);

  // maxMatches truncates and says so.
  const many = [art({ id: "m", content: Array.from({ length: 10 }, () => "hit").join("\n") })];
  const capped = searchArtifactText(many, "hit", { maxMatches: 3 });
  assert.equal(capped.matches.length, 3);
  assert.equal(capped.truncated, true);
});

test("searchArtifactText reports misuse instead of silently finding nothing", () => {
  // Invalid regex must not be silently treated as literal text: a caller looking for
  // "retry (" would otherwise think the text is absent rather than the pattern broken.
  assert.throws(
    () => searchArtifactText([art()], "unclosed(", { regex: true }),
    /Invalid search regular expression/,
  );
  assert.throws(() => searchArtifactText([art()], ""), /requires a non-empty query/);
});

test("applyArtifactEdit covers append, replace, insert and replaceLines without whole-document rewrites", () => {
  const base = "one\ntwo\nthree";

  const appended = applyArtifactEdit(base, { mode: "append", content: "four" });
  assert.equal(appended.content, "one\ntwo\nthree\nfour");

  const replaced = applyArtifactEdit(base, { mode: "replace", oldString: "two", newString: "TWO" });
  assert.equal(replaced.content, "one\nTWO\nthree");

  // Deleting a match is a legitimate replace with newString "".
  assert.equal(applyArtifactEdit(base, { mode: "replace", oldString: "two\n", newString: "" }).content, "one\nthree");

  const insertedBefore = applyArtifactEdit(base, { mode: "insert", line: 2, where: "before", content: "x\ny" });
  assert.equal(insertedBefore.content, "one\nx\ny\ntwo\nthree");
  const insertedAfter = applyArtifactEdit(base, { mode: "insert", line: 2, content: "z" });
  assert.equal(insertedAfter.content, "one\ntwo\nz\nthree", "default anchor is after");

  const replacedLines = applyArtifactEdit(base, { mode: "replaceLines", startLine: 2, endLine: 3, content: "mid" });
  assert.equal(replacedLines.content, "one\nmid");
  // endLine defaults to startLine, so a single line is replaceable.
  assert.equal(applyArtifactEdit(base, { mode: "replaceLines", startLine: 1, content: "head" }).content, "head\ntwo\nthree");

  assert.ok(artifactLineCount("").valueOf() === 1);
  assert.equal(artifactLineCount("a\nb\nc"), 3);
});

test("applyArtifactEdit refuses ambiguous or out-of-range edits with actionable errors", () => {
  const base = "dup\ndup\nthird";

  // Ambiguous occurrence must be disambiguated, not guessed at.
  assert.equal(applyArtifactEdit(base, { mode: "replace", oldString: "dup", newString: "one", occurrence: 1 }).content, "one\ndup\nthird");
  assert.equal(applyArtifactEdit(base, { mode: "replace", oldString: "dup", newString: "second", occurrence: 2 }).content, "dup\nsecond\nthird");
  assert.throws(
    () => applyArtifactEdit(base, { mode: "replace", oldString: "dup", newString: "x", occurrence: 3 }),
    /out of range; `oldString` occurs 2 time\(s\)/,
  );

  // A miss must explain how to recover, since the usual cause is a stale copy.
  assert.throws(
    () => applyArtifactEdit(base, { mode: "replace", oldString: "absent", newString: "x" }),
    /not found\. Read the range first/,
  );

  for (const spec of [
    { mode: "append" as const, content: "" },
    { mode: "insert" as const, line: 1, content: "" },
  ]) {
    assert.throws(() => applyArtifactEdit(base, spec), /requires a non-empty `content`/);
  }
  assert.throws(() => applyArtifactEdit(base, { mode: "insert", content: "x" }), /requires a 1-based `line`/);
  assert.throws(() => applyArtifactEdit(base, { mode: "insert", line: 99, content: "x" }), /out of range; the artifact has 3 line\(s\)/);
  assert.throws(() => applyArtifactEdit(base, { mode: "replaceLines", startLine: 2, endLine: 9, content: "x" }), /line range 2-9 is invalid/);
  assert.throws(() => applyArtifactEdit(base, { mode: "replaceLines", startLine: 3, endLine: 1, content: "x" }), /start must not exceed end/);
});

// ── Tools ──

test("artifact_recall returns a line range with navigation instead of the whole document", async () => {
  const h = harness();
  const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  await h.call("artifact_save", { id: "long", title: "Long doc", type: "spec", content: body });

  const full = await h.call("artifact_recall", { id: "long" });
  assert.match(full.content[0].text, /line 40/, "full recall is unchanged when no range is asked for");
  assert.doesNotMatch(full.content[0].text, /│/, "no gutter without a range");

  const range = await h.call("artifact_recall", { id: "long", offset: 10, limit: 5 });
  const text = range.content[0].text;
  assert.match(text, /Lines 10-14 of 40\./);
  assert.match(text, /10│ line 10/);
  assert.match(text, /14│ line 14/);
  assert.doesNotMatch(text, /line 15\n/, "must not leak beyond the requested range");
  assert.doesNotMatch(text, /^line 9$/m);
  assert.equal(range.details.startLine, 10);
  assert.equal(range.details.endLine, 14);
  assert.equal(range.details.totalLines, 40);
  assert.equal(range.details.truncated, true);
  // Navigation is actionable, not just descriptive.
  assert.match(text, /artifact_recall\(\{ id: "long", offset: 1, limit: 9 \}\)/);
  assert.match(text, /artifact_recall\(\{ id: "long", offset: 15 \}\)/);

  // Reading the tail: no "later" hint when nothing follows.
  const tail = await h.call("artifact_recall", { id: "long", offset: 38 });
  assert.match(tail.content[0].text, /Lines 38-40 of 40\./);
  assert.doesNotMatch(tail.content[0].text, /Later lines/);

  // lineNumbers:false is the copy-safe form for artifact_edit oldString.
  const raw = await h.call("artifact_recall", { id: "long", offset: 3, limit: 2, lineNumbers: false });
  assert.doesNotMatch(raw.content[0].text.split("Lines")[1], /│/);
  assert.match(raw.content[0].text, /line 3/);

  // Out-of-range offset is reported as a mistake, not as an empty artifact.
  const past = await h.call("artifact_recall", { id: "long", offset: 999 });
  assert.match(past.content[0].text, /past the end/);
  assert.equal(past.details.empty, true);
});

test("artifact_search locates text inside a body and hands back a usable offset", async () => {
  const h = harness();
  await h.call("artifact_save", {
    id: "spec", title: "Spec", type: "spec",
    content: "# Goal\nImplement retry.\n\n## Lane\nsrc/net/client.ts\n\n## Criteria\nBackoff is exponential",
  });
  await h.call("artifact_save", { id: "other", title: "Other", type: "scratchpad", content: "nothing relevant" });

  const hit = await h.call("artifact_search", { query: "client.ts" });
  assert.equal(hit.details.count, 1);
  // "client.ts" starts at column 9 of "src/net/client.ts".
  assert.match(hit.content[0].text, /\[spec\] "Spec" — line 5 of 8, col 9/);
  assert.match(hit.content[0].text, /5│ src\/net\/client\.ts/);
  assert.match(hit.content[0].text, /artifact_recall\(\{ id: "spec", offset: 5/);
  assert.deepEqual(hit.details.hits, [{ id: "spec", line: 5, column: 9 }]);

  // Scoped to one artifact, and category-filtered.
  assert.equal((await h.call("artifact_search", { query: "retry", id: "other" })).details.count, 0);
  assert.equal((await h.call("artifact_search", { query: "retry", type: "scratchpad" })).details.count, 0);
  assert.equal((await h.call("artifact_search", { query: "retry", type: "spec" })).details.count, 1);

  // Regex opt-in and case sensitivity.
  assert.equal((await h.call("artifact_search", { query: "^## ", regex: true })).details.count, 2);
  assert.equal((await h.call("artifact_search", { query: "RETRY", caseSensitive: true })).details.count, 0);
  assert.equal((await h.call("artifact_search", { query: "RETRY" })).details.count, 1);

  // A miss names what was searched rather than implying the catalog is empty.
  const miss = await h.call("artifact_search", { query: "zzz-absent" });
  assert.equal(miss.details.count, 0);
  assert.match(miss.content[0].text, /in 2 artifact\(s\)/);

  await assert.rejects(() => h.call("artifact_search", { query: "(" , regex: true }), /Invalid search regular expression/);
  await assert.rejects(() => h.call("artifact_search", { query: "x", id: "nope" }), /not found/);
});

test("artifact_edit patches an existing artifact, bumps the version and keeps the rest intact", async () => {
  const h = harness();
  const original = "# Plan\n\n## Step 1\nold body\n\n## Step 2\nkeep me intact\n\n## Step 3\ntail";
  await h.call("artifact_save", { id: "plan", title: "Plan", type: "plan", content: original });

  const edited = await h.call("artifact_edit", {
    id: "plan", mode: "replace", oldString: "old body", newString: "new body",
  });
  assert.equal(edited.details.version, 2);
  assert.match(edited.content[0].text, /edited \(v2/);

  const after = await h.call("artifact_recall", { id: "plan" });
  assert.match(after.content[0].text, /new body/);
  // The point of the feature: untouched sections survive without being retyped.
  assert.match(after.content[0].text, /## Step 2\nkeep me intact/);
  assert.match(after.content[0].text, /## Step 3\ntail/);
  assert.doesNotMatch(after.content[0].text, /old body/);

  // Version history is versioned state, not a rewritten v1: the branch holds v2.
  const versions = h.entries.filter(e => e.data?.id === "plan").map(e => e.data.version);
  assert.deepEqual(versions, [1, 2], "each edit is its own versioned entry");

  // appending and line-range replacement continue from there.
  assert.equal((await h.call("artifact_edit", { id: "plan", mode: "append", content: "## Step 4\nnew" })).details.version, 3);
  const byRange = await h.call("artifact_edit", { id: "plan", mode: "replaceLines", startLine: 4, endLine: 5, content: "collapsed" });
  assert.equal(byRange.details.version, 4);
  const final = await h.call("artifact_recall", { id: "plan" });
  assert.match(final.content[0].text, /collapsed/);
  assert.match(final.content[0].text, /## Step 2\nkeep me intact/, "sections far from the edit are untouched");
  assert.match(final.content[0].text, /## Step 4\nnew/);

  // Editing metadata in the same call.
  const retitled = await h.call("artifact_edit", { id: "plan", mode: "append", content: "x", title: "Renamed Plan", tags: ["a"] });
  assert.equal(retitled.details.version, 5);
  assert.match((await h.call("artifact_recall", { id: "plan" })).content[0].text, /renamed plan/i);
});

test("artifact_edit refuses a no-op, a missing artifact and a bad range", async () => {
  const h = harness();
  await h.call("artifact_save", { id: "doc", title: "Doc", type: "spec", content: "a\nb" });

  // Replacing a match with itself would bump the version while changing nothing.
  await assert.rejects(
    () => h.call("artifact_edit", { id: "doc", mode: "replace", oldString: "a", newString: "a" }),
    /changed nothing, so no version was recorded/,
  );
  assert.equal(h.entries.filter(e => e.data?.id === "doc").length, 1, "no version recorded");

  await assert.rejects(() => h.call("artifact_edit", { id: "ghost", mode: "append", content: "x" }), /not found/);
  await assert.rejects(
    () => h.call("artifact_edit", { id: "doc", mode: "replaceLines", startLine: 5, endLine: 6, content: "x" }),
    /line range 5-6 is invalid/,
  );
  await assert.rejects(
    () => h.call("artifact_edit", { id: "doc", mode: "insert", line: 9, content: "x" }),
    /out of range; the artifact has 2 line\(s\)/,
  );
});

// ── Isolation ──

test("a child's spec stays readable and editable in its own scope, and the parent's edit keeps it sidecar-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-artifact-edit-"));
  const childSession = join(dir, "child_session.jsonl");
  try {
    // The parent authors a scoped spec. It is deliberately stored sidecar-only so a
    // child fork cannot inherit it from the branch.
    const parentSession = join(dir, "parent_session.jsonl");
    const appendedParent: any[] = [];
    const parentTools = new Map<string, any>();
    const parentPi: any = {
      on() {},
      registerTool(tool: any) { parentTools.set(tool.name, tool); },
      registerCommand() {},
      appendEntry(customType: string, data: any) { appendedParent.push({ customType, data }); },
    };
    const parentContext: any = {
      hasUI: false,
      sessionManager: { getBranch: () => [], getSessionFile: () => parentSession },
      ui: { setWidget() {}, notify() {} },
    };
    artifactsExtension(parentPi);
    const parentCall = (name: string, args: any) =>
      parentTools.get(name).execute(`p-${name}`, args, undefined, undefined, parentContext);

    await parentCall("artifact_save", {
      id: "net-spec", title: "Net spec", type: "spec", scope: "net-retry",
      content: "# Goal\nretry\n# Lane\nsrc/net/client.ts",
    });
    assert.equal(appendedParent.length, 0, "scoped spec never lands on the forkable branch");

    // Editing it through artifact_edit must not change that placement decision.
    const edited = await parentCall("artifact_edit", { id: "net-spec", mode: "append", content: "# Extra\nstay scoped" });
    assert.equal(edited.details.sidecarOnly, true, "edit preserves sidecar-only placement");
    assert.equal(edited.details.scope, "net-retry");
    assert.equal(appendedParent.length, 0, "an edit must not leak the spec onto the branch");

    const sidecar = await readSidecarArtifact(`${parentSession}.artifact.net-spec.json`);
    assert.ok(sidecar);
    assert.ok(sidecar!.content.includes("stay scoped"), "sidecar holds the edited content");
    assert.equal(sidecar!.version, 2);

    // A branch-only read would miss it entirely, so the catalog must include sidecars.
    const reread = await parentCall("artifact_recall", { id: "net-spec" });
    assert.match(reread.content[0].text, /stay scoped/);
    assert.match((await parentCall("artifact_search", { query: "stay scoped" })).content[0].text, /line/);

    // The child in that scope sees it and can edit it. Delivery happens through the
    // child snapshot — the same handoff the v2 spawn path performs. Without it a
    // scoped spec is deliberately unreachable from the child, so this step is the
    // mechanism being tested, not test scaffolding.
    await publishChildSnapshot(dir, childSession, "net-retry", [sidecar!]);
    const child = harness({ isChild: true, childSession, childRun: "run-1", childName: "NetWorker", childScope: "net-retry" });
    const childView = await child.call("artifact_recall", { id: "net-spec" });
    assert.match(childView.content[0].text, /stay scoped/);
    const childEdit = await child.call("artifact_edit", { id: "net-spec", mode: "append", content: "child note" });
    assert.equal(childEdit.details.staged, true, "child edits stage back to the parent like saves do");
    const staged = await readSidecarArtifact(`${childSession}.artifact.net-spec.json`);
    assert.ok(staged);
    assert.ok(staged!.content.includes("child note"));
    assert.equal(staged!.createdBy, "main", "author is preserved from the original, not rewritten");

    // A child in a DIFFERENT scope must not see either spec.
    const sibling = harness({
      isChild: true, childSession: join(dir, "sibling.jsonl"), childRun: "run-2",
      childName: "DbWorker", childScope: "db-pool",
    });
    await assert.rejects(() => sibling.call("artifact_recall", { id: "net-spec" }), /not found/);
    await assert.rejects(() => sibling.call("artifact_edit", { id: "net-spec", mode: "append", content: "x" }), /not found/);
    assert.equal((await sibling.call("artifact_search", { query: "stay scoped" })).details.count, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a child's own saved artifact is editable in place rather than re-saved in full", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-child-edit-"));
  const childSession = join(dir, "child_session.jsonl");
  try {
    const child = harness({ isChild: true, childSession, childRun: "run-1", childName: "Worker", childScope: "work-a" });
    await child.call("artifact_save", {
      id: "findings", title: "Findings", type: "scratchpad",
      content: "## Finding 1\nleak in pool\n\n## Finding 2\nkeep this",
    });

    const edited = await child.call("artifact_edit", {
      id: "findings", mode: "replace", oldString: "leak in pool", newString: "leak fixed in pool",
    });
    assert.equal(edited.details.staged, true);
    assert.equal(edited.details.version, 2);

    const staged = await readSidecarArtifact(`${childSession}.artifact.findings.json`);
    assert.ok(staged!.content.includes("leak fixed in pool"));
    assert.ok(staged!.content.includes("## Finding 2\nkeep this"), "the rest is not retyped");
    assert.equal(staged!.scope, "work-a");
    assert.match(staged!.createdBy, /^subagent:Worker:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a handoff spec is frozen for a child: it can read the document but not rewrite it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-handoff-freeze-"));
  const childSession = join(dir, "child.jsonl");
  try {
    const handoff = art({
      id: "handoff-core-abc",
      title: "Handoff: core — build it",
      type: "spec",
      scope: "core",
      content: "# Work handoff: core\n## Goal\nBuild it.",
    });
    await publishChildSnapshot(dir, childSession, "core", [handoff]);
    const child = harness({ isChild: true, childSession, childRun: "r1", childName: "Worker", childScope: "core" });

    // The spec is readable: the receipt depends on exactly this call.
    assert.match((await child.call("artifact_recall", { id: "handoff-core-abc" })).content[0].text, /Build it/);

    // Rewriting it is refused, and nothing is staged by the refusal.
    await assert.rejects(
      () => child.call("artifact_save", { id: "handoff-core-abc", title: "Handoff", type: "spec", content: "# replaced" }),
      /read-only for a worker/,
    );
    await assert.rejects(
      () => child.call("artifact_edit", { id: "handoff-core-abc", mode: "append", content: "\nmore" }),
      /read-only for a worker/,
    );
    assert.equal(
      await readSidecarArtifact(`${childSession}.artifact.handoff-core-abc.json`),
      undefined,
      "a refused write must not leave a staged copy behind",
    );

    // The read still works after the refusals, so the freeze is narrow.
    assert.match((await child.call("artifact_recall", { id: "handoff-core-abc" })).content[0].text, /Build it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
