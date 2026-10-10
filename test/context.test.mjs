import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardContext, BOARD_INSTRUCTIONS } from '../src/context.mjs';
import { associatedSession } from '../src/submission.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-board-context-'));
  t.after(async () => { assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-context-')); await rm(directory, { recursive: true, force: true }); });
  const context = new BoardContext(join(directory, 'state.json')); await context.ready;
  return { context, directory };
}
const selected = id => ({ boardId: 'b_board01', cards: [{ id, title: id, markdown: 'Do not copy card body' }] });
const message = id => ({ source: { kind: 'user', rpcId: id } });
test('queued replies keep their own associations; subsequent unassociated reply clears them', async t => {
  const { context } = await fixture(t);
  await context.stage('session1', 'request1', selected('n_card001'));
  await context.stage('session1', 'request2', selected('n_card002'));
  context.claim('session1', message('request1'));
  assert.ok(context.render('session1', 'b_board01').includes('n_card001'));
  assert.ok(!context.render('session1', 'b_board01').includes('n_card002'));
  context.claim('session1', message('request2'));
  assert.ok(context.render('session1', 'b_board01').includes('n_card002'));
  assert.ok(!context.render('session2', 'b_board01').includes('n_card002'));
  context.claim('session1', message('request3'));
  assert.ok(context.render('session1', 'b_board01').includes('"cards":[]'));
});
test('equal selections produce identical context despite new message IDs and ordering', async t => {
  const { context } = await fixture(t);
  const association = { boardId: 'b_board01', cards: [{ id: 'n_card001', title: 'A' }, { id: 'n_card002', title: 'B' }] };
  await context.stage('session1', 'request1', association); context.claim('session1', message('request1'));
  const first = context.render('session1', 'b_board01');
  await context.stage('session1', 'request2', { ...association, cards: association.cards.toReversed() }); context.claim('session1', message('request2'));
  assert.equal(context.render('session1', 'b_board01'), first);
  assert.ok(!first.includes('request1')); assert.ok(!first.includes('request2'));
  assert.ok(!BOARD_INSTRUCTIONS.includes('b_board01'));
});
test('pending associations and preferences survive restart; another board excludes stale card references', async t => {
  const { context, directory } = await fixture(t);
  await context.stage('session1', 'request1', selected('n_card001'));
  await context.configure({ associateSelection: false });
  const restored = new BoardContext(join(directory, 'state.json')); await restored.ready;
  restored.claim('session1', message('request1'));
  assert.ok(restored.render('session1', 'b_board01').includes('"cards":[]'));
  await restored.configure({ associateSelection: true });
  assert.ok(restored.render('session1', 'b_board01').includes('n_card001'));
  assert.ok(!restored.render('session1', 'b_other01').includes('n_card001'));
  await restored.configure({ enabled: false }); assert.equal(restored.render('session1', 'b_board01'), '');
  await assert.rejects(restored.configure({ enabled: 'no' }), /Invalid/);
  await assert.rejects(restored.configure({ unrelated: true }), /Invalid/);
});
test('native submission sends user content unchanged and stages metadata under the exact admission ID', async () => {
  const calls = []; const content = [{ type: 'text', text: '解释这张卡片' }, { type: 'image', data: 'fixture' }];
  const signal = new AbortController().signal;
  const native = { sessionId: 'session1', beginSubmission() { assert.equal(this, native); return 'native-echo'; }, async prompt(...args) { assert.equal(this, native); calls.push(['prompt', ...args]); return { ok: true }; } };
  const selection = selected('n_card001');
  const wrapped = associatedSession(native, selection, { stage: async (...args) => calls.push(['stage', ...args]), discard: async () => {} });
  assert.equal(wrapped.beginSubmission(), 'native-echo');
  await wrapped.prompt(content, 'steer', signal, 'request1');
  assert.deepEqual(calls[0], ['stage', 'session1', 'request1', selection, signal]);
  assert.deepEqual(calls[1], ['prompt', content, 'steer', signal, 'request1']);
  assert.equal(content[0].text, '解释这张卡片');
});
