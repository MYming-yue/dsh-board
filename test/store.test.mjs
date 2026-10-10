import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardStore } from '../src/store.mjs';
import { createEmptyBoard, serializeBoard } from '../lib/model.js';
import { normalizeAssociation } from '../src/context.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-board-test-'));
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const store = new BoardStore(directory); await store.ready;
  return { store, directory };
}
function batch(file, markdown = '共同理解') {
  const node = { id: 'n_agent001', type: 'text', markdown, x: 80, y: 120, w: 240 };
  return { batchVersion: '1.0', boardId: file.board.id, baseContentVersion: file.board.contentVersion,
    actor: 'agent', label: '添加概念', ops: [{ op: 'addNode', node, before: null, after: node }] };
}
test('browser snapshot cannot overwrite a concurrent AI batch', async t => {
  const { store } = await fixture(t);
  const before = await store.snapshot();
  const changed = await store.apply(batch(await store.read()));
  assert.ok(changed.ok);
  await assert.rejects(store.sync({ ...before, data: before.data }), error => error.code === 'E_SYNC_CONFLICT');
  assert.equal((await store.read()).nodes[0].markdown, '共同理解');
});
test('invalid/midway-failing batch changes neither content nor revision', async t => {
  const { store } = await fixture(t);
  const before = await store.snapshot();
  const bad = batch(await store.read());
  bad.ops.push({ op: 'removeNode', nodeId: 'n_missing00', before: null, after: null });
  const result = await store.apply(bad);
  assert.equal(result.ok, false);
  assert.deepEqual(await store.snapshot(), before);
});
test('current draft survives restart; stale generation and stale model versions are rejected', async t => {
  const { store, directory } = await fixture(t);
  const before = await store.snapshot();
  assert.ok((await store.apply(batch(await store.read()))).ok);
  const resumed = new BoardStore(directory); await resumed.ready;
  assert.equal((await resumed.read()).nodes[0].markdown, '共同理解');
  await assert.rejects(resumed.sync(before), /共同草稿已更新/);
  const outdated = batch(await resumed.read()); outdated.baseContentVersion = 0;
  assert.equal((await resumed.apply(outdated)).error.code, 'E_VERSION_CONFLICT');
});
test('explicit board change preserves previous file; implicit identity change is rejected', async t => {
  const { store, directory } = await fixture(t);
  const snapshot = await store.snapshot();
  const data = Buffer.from(serializeBoard(createEmptyBoard('另一任务'), {})).toString('base64');
  await assert.rejects(store.sync({ revision: snapshot.revision, data }), error => error.code === 'E_BOARD_MISMATCH');
  await store.sync({ revision: snapshot.revision, data, replace: true, fileName: '另一任务.draft' });
  assert.equal((await store.read()).board.name, '另一任务');
  assert.equal((await readdir(join(directory, 'boards'))).filter(name => name.endsWith('.draft')).length, 2);
});
test('message association contains stable identities and short titles, not card body', () => {
  const cards = [{ id: 'n_card001', title: 'A [概念]', markdown: '不应自动附上全文' }];
  const refs = normalizeAssociation({ boardId: 'b_board01', cards });
  assert.equal(refs.cards[0].id, 'n_card001');
  assert.equal(refs.cards[0].title, 'A [概念]');
  assert.ok(!JSON.stringify(refs).includes('不应自动附上全文'));
  assert.deepEqual(normalizeAssociation(null), { boardId: null, cards: [] });
});
