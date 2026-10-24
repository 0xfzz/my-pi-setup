import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

// Exercise the installed TS with Pi's real projection and no live session/API.
//
// This harness targets a machine that has both packages installed, so it is opt-in:
// point the two variables at the installed trees. It is kept as provenance for
// vcc-projected-compaction-recall.patch, not as part of `npm test`.
const runtime = process.env.PI_RUNTIME_ROOT;
const vcc = process.env.VCC_ROOT;
if (!runtime || !vcc) {
  console.error(
    'SKIP: this harness needs the installed packages. Set PI_RUNTIME_ROOT to a Pi ' +
      'install\'s node_modules and VCC_ROOT to the installed pi-vcc directory.',
  );
  process.exit(0);
}
const require = createRequire(import.meta.url);
const { createJiti } = require(`${runtime}/jiti`);
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    '@mariozechner/pi-coding-agent': `${runtime}/@earendil-works/pi-coding-agent/dist/index.js`,
    '@mariozechner/pi-ai': `${runtime}/@earendil-works/pi-ai/dist/index.js`,
    '@mariozechner/pi-tui': `${runtime}/@earendil-works/pi-tui/dist/index.js`,
  },
});
const tmp = path.join(path.dirname(fileURLToPath(import.meta.url)), `.fixtures-${process.pid}`);
await mkdir(tmp, { recursive: true });
after(() => rm(tmp, { recursive: true, force: true }));
process.env.PI_VCC_CONFIG_PATH = path.join(tmp, 'config.json');
await writeFile(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
const { prepareCompaction } = await import(`${runtime}/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`);
const { SessionManager, buildSessionContext, buildSessionProjection } = await import(`${runtime}/@earendil-works/pi-coding-agent/dist/index.js`);
const { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION, getLastCompactionStats } = await jiti.import(`${vcc}/src/hooks/before-compact.ts`);
const { loadAllMessages } = await jiti.import(`${vcc}/src/core/load-messages.ts`);
const { searchEntries } = await jiti.import(`${vcc}/src/core/search-entries.ts`);
const { getActiveLineageEntryIds } = await jiti.import(`${vcc}/src/core/lineage.ts`);
const { compile } = await jiti.import(`${vcc}/src/core/summarize.ts`);
const timestamp = '2026-10-18T00:00:00.000Z';
function chain(specs) {
  return specs.map((spec, i) => ({ timestamp, parentId: i ? specs[i - 1].id : null, ...spec }));
}
const text = (s) => [{ type: 'text', text: s }];
const msg = (id, role, content, rest = {}) => ({ id, type: 'message', message: { role, content: role === 'user' ? content : text(content), timestamp: 0, ...rest } });
const custom = (id, content, display = true) => ({ id, type: 'custom_message', customType: 'herdr-result', content, display });
const settings = { enabled: true, keepRecentTokens: 1, reserveTokens: 1024 };
function harness() {
  const handlers = new Map();
  registerBeforeCompactHook({ on: (event, callback) => handlers.set(event, callback) });
  const ctx = { sessionManager: {}, ui: { notify() {} } };
  return { ctx, handlers, run: (entries, preparation = prepareCompaction(entries, settings), explicit = true) => {
    assert.ok(preparation, 'fixture must produce a core preparation');
    return handlers.get('session_before_compact')({ branchEntries: entries, preparation, customInstructions: explicit ? PI_VCC_COMPACT_INSTRUCTION : undefined }, ctx);
  } };
}
const base = () => chain([
  msg('u1', 'user', 'Implement projection fixes'),
  custom('c1', text('HERDR_UNIQUE_RESULT: DONE implement file repair'), false),
  { id: 'b1', type: 'branch_summary', fromId: 'other', summary: 'BRANCH_UNIQUE_CONTEXT: use projected entries' },
  msg('a1', 'assistant', 'Implemented the requested repair'),
  msg('u2', 'user', 'Verify the repair'),
  msg('a2', 'assistant', 'Verification succeeded'),
]);

test('VCC remains deterministic/no API and uses both projected prefix lists and exact boundary', async () => {
  const entries = base();
  const prep = prepareCompaction(entries, settings);
  const h = harness();
  const result = await h.run(entries, prep);
  assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
  assert.equal(result.compaction.tokensBefore, prep.tokensBefore);
  assert.equal(result.compaction.summary, await compile({ messages: (await import(`${runtime}/@earendil-works/pi-coding-agent/dist/index.js`)).convertToLlm([...prep.messagesToSummarize, ...prep.turnPrefixMessages]), previousSummary: prep.previousSummary }));
  assert.match(result.compaction.summary, /HERDR_UNIQUE_RESULT/);
  assert.match(result.compaction.summary, /BRANCH_UNIQUE_CONTEXT/);
  assert.ok(prep.turnPrefixMessages.length > 0, 'exercise split-turn prefix');
  assert.equal(result.compaction.details.sourceMessageCount, prep.messagesToSummarize.length + prep.turnPrefixMessages.length);
  const rebuilt = buildSessionContext([...entries, { id: 'compact1', type: 'compaction', parentId: entries.at(-1).id, timestamp, ...result.compaction }]);
  assert.ok(rebuilt.messages.length > 0);
  await h.handlers.get('session_compact')({ fromExtension: true }, h.ctx);
  assert.equal(getLastCompactionStats().summarized, result.compaction.details.sourceMessageCount);
});

test('context replacements and omissions affect summaries, not raw history', async () => {
  const entries = chain([...base(),
    { id: 'edit1', type: 'context_edit', targetId: 'c1', replacement: { content: 'REPLACEMENT_UNIQUE: DONE repaired safely' } },
    { id: 'edit2', type: 'context_edit', targetId: 'a1', replacement: null },
  ]);
  const result = await harness().run(entries);
  assert.match(result.compaction.summary, /REPLACEMENT_UNIQUE/);
  assert.doesNotMatch(result.compaction.summary, /HERDR_UNIQUE_RESULT|Implemented the requested repair/);
  assert.match(result.compaction.summary, /BRANCH_UNIQUE_CONTEXT/);
});

test('tool calls and all parallel results remain on the same side of the cut', async () => {
  const entries = chain([
    msg('u1', 'user', 'Implement tools'),
    custom('c1', 'DONE HERDR_TOOL_PREFIX'),
    msg('a1', 'assistant', '', { content: [
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'toolCall', id: 't2', name: 'read', arguments: { path: 'b.ts' } },
    ] }),
    msg('r1', 'toolResult', 'First result', { toolCallId: 't1', toolName: 'read', isError: false }),
    msg('r2', 'toolResult', 'Second result', { toolCallId: 't2', toolName: 'read', isError: false }),
  ]);
  const prep = prepareCompaction(entries, settings);
  const result = await harness().run(entries, prep);
  assert.equal(result.compaction.firstKeptEntryId, 'a1');
  assert.equal(prep.messagesToSummarize.concat(prep.turnPrefixMessages).some(m => m.role === 'toolResult'), false);
  const context = buildSessionContext([...entries, { id: 'cmp', type: 'compaction', parentId: 'r2', timestamp, ...result.compaction }]);
  assert.deepEqual(context.messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId), ['t1', 't2']);
});

test('repeat compaction includes previously retained custom content and previous VCC summary', async () => {
  const entries = base();
  const first = await harness().run(entries);
  const repeated = chain([...entries,
    { id: 'cmp', type: 'compaction', ...first.compaction },
    custom('c2', 'REPEAT_HERDR_RESULT: DONE repeated repair'),
    msg('u3', 'user', 'Implement the next repair'),
    msg('a3', 'assistant', 'Next repair complete'),
  ]);
  const prep = prepareCompaction(repeated, settings);
  assert.equal(prep.previousSummary, first.compaction.summary);
  const result = await harness().run(repeated, prep);
  assert.match(result.compaction.summary, /HERDR_UNIQUE_RESULT/);
  assert.match(result.compaction.summary, /REPEAT_HERDR_RESULT/);
  assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
});

test('a newly appended custom result stays verbatim in the retained tail', async () => {
  const entries = chain([...base(), custom('tail', 'TAIL_CUSTOM_UNIQUE: unsent subagent result', false)]);
  const prep = prepareCompaction(entries, settings);
  const result = await harness().run(entries, prep);
  assert.equal(result.compaction.firstKeptEntryId, 'tail');
  assert.doesNotMatch(result.compaction.summary, /TAIL_CUSTOM_UNIQUE/);
  const rebuilt = buildSessionContext([...entries, { id: 'cmp', type: 'compaction', parentId: 'tail', timestamp, ...result.compaction }]);
  assert.ok(rebuilt.messages.some(m => m.role === 'custom' && m.content === 'TAIL_CUSTOM_UNIQUE: unsent subagent result'));
});

test('custom-started histories do not require a raw user message', async () => {
  const entries = chain([custom('c', 'CUSTOM_START_UNIQUE: implement the repair'), msg('a', 'assistant', 'Repair complete')]);
  const prep = prepareCompaction(entries, settings);
  const result = await harness().run(entries, prep);
  assert.match(result.compaction.summary, /CUSTOM_START_UNIQUE/);
  assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
});

test('legacy missing/empty and modern retain-none boundaries follow Pi preparation', async () => {
  for (const boundary of ['', 'missing', 'cmp']) {
    const entries = chain([
      msg('old', 'user', 'OLD_RAW_CONTEXT'),
      { id: 'cmp', type: 'compaction', summary: '[Session Goal]\n- Previous repair', tokensBefore: 999, firstKeptEntryId: boundary },
      custom('new', 'NEW_LIVE_CONTEXT: DONE implement repair'),
      msg('u', 'user', 'Verify next'), msg('a', 'assistant', 'Verified'),
    ]);
    const prep = prepareCompaction(entries, settings);
    const result = await harness().run(entries, prep);
    assert.equal(result.compaction.firstKeptEntryId, prep.firstKeptEntryId);
    assert.match(result.compaction.summary, /NEW_LIVE_CONTEXT/);
    assert.doesNotMatch(result.compaction.summary, /OLD_RAW_CONTEXT/);
  }
});

test('recall loads hidden/array custom messages and branch summaries; scoped/full indices align', async () => {
  const entries = chain([
    msg('u', 'user', 'Implement recall'),
    { id: 'state', type: 'custom', customType: 'herdr-state', data: { secret: 'STATE_ONLY' } },
    custom('c', [...text('needle_custom ' + 'x'.repeat(400)), { type: 'image', mimeType: 'image/png', data: 'not-real-image' }], false),
    custom('off', 'OFF_BRANCH_ONLY'),
    { id: 'b', type: 'branch_summary', fromId: 'other', summary: 'needle_branch summary context' },
    msg('a', 'assistant', 'Final'),
    { id: 'edit', type: 'context_edit', targetId: 'c', replacement: null },
  ]);
  const file = path.join(tmp, 'recall.jsonl');
  await writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n{broken\n');
  const all = await loadAllMessages(file, false);
  const scoped = await loadAllMessages(file, true, new Set(['c', 'b', 'a']));
  assert.deepEqual(all.entryIds, ['u', 'c', 'off', 'b', 'a']);
  assert.deepEqual(scoped.rendered.map(e => e.index), [1, 3, 4]);
  assert.equal(scoped.rendered[0].role, 'custom');
  assert.match(scoped.rendered[0].summary, /^\[herdr-result\] needle_custom/);
  assert.ok(scoped.rendered[0].summary.length > all.rendered[1].summary.length);
  assert.equal(scoped.rendered[1].role, 'branch_summary');
  assert.equal(searchEntries(all.rendered, all.rawMessages, 'needle_custom')[0].index, 1);
  assert.equal(searchEntries(all.rendered, all.rawMessages, 'needle_branch')[0].index, 3);
  assert.equal(all.parseFailures.length, 1);
  assert.equal(all.rawMessages.length, all.entryIds.length);
  assert.equal(buildSessionProjection(entries).messages.some(m => JSON.stringify(m).includes('needle_custom')), false);
});

test('real SessionManager resetLeaf leaves lineage recall empty without exposing abandoned history', async () => {
  const manager = SessionManager.inMemory(tmp);
  const abandonedId = manager.appendMessage({ role: 'user', content: 'ABANDONED_ROOT_UNIQUE', timestamp: 0 });
  manager.appendMessage({ role: 'assistant', content: text('ABANDONED_RESPONSE_UNIQUE'), timestamp: 0 });
  assert.ok(getActiveLineageEntryIds(manager).has(abandonedId));

  manager.resetLeaf();
  assert.deepEqual(manager.getBranch(), []);
  assert.equal(manager.getEntries().length, 2, 'raw history is not erased');
  const emptyAllowlist = getActiveLineageEntryIds(manager);
  assert.equal(emptyAllowlist.size, 0, 'empty branch must not fall back to getEntries');
  const file = path.join(tmp, 'reset-leaf.jsonl');
  await writeFile(file, manager.getEntries().map(e => JSON.stringify(e)).join('\n'));
  assert.equal((await loadAllMessages(file, false, emptyAllowlist)).rendered.length, 0);
  assert.equal((await loadAllMessages(file, false)).rendered.length, 2, 'explicit all scope still works');

  const newId = manager.appendMessage({ role: 'user', content: 'NEW_ROOT_UNIQUE', timestamp: 0 });
  assert.deepEqual([...getActiveLineageEntryIds(manager)], [newId]);
  await writeFile(file, manager.getEntries().map(e => JSON.stringify(e)).join('\n'));
  const active = await loadAllMessages(file, true, getActiveLineageEntryIds(manager));
  assert.deepEqual(active.entryIds, [newId]);
  assert.match(active.rendered[0].summary, /NEW_ROOT_UNIQUE/);
  assert.equal(active.rendered[0].index, 2, 'raw-history indices retain abandoned-branch gaps');
});

test('opt-out does not intercept default compaction; failed compaction never publishes pending stats', async () => {
  const h = harness();
  await h.handlers.get('session_start')();
  await h.run(base());
  await h.handlers.get('session_compact_failed')({}, h.ctx);
  await h.handlers.get('session_compact')({ fromExtension: true }, h.ctx);
  assert.equal(getLastCompactionStats(), null);
  await writeFile(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: false, debug: false }));
  try { assert.equal(await h.run(base(), undefined, false), undefined); }
  finally { await writeFile(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, debug: false })); }
});
