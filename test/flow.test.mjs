import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardStore } from '../src/store.mjs';
import { invertOps, parseBoard } from '../lib/model.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-board-flow-'));
  t.after(async () => {
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-flow-'));
    await rm(directory, { recursive: true, force: true });
  });
  const store = new BoardStore(directory); await store.ready;
  return { store, directory };
}
async function apply(store, ops) {
  const current = await store.read();
  return store.apply({ batchVersion: '1.0', boardId: current.board.id,
    baseContentVersion: current.board.contentVersion, actor: 'agent', label: '合成流程外形', ops });
}
async function seed(store) {
  const a = { id: 'n_flow001', type: 'text', markdown: '条件是否清楚？', caption: '保留判断依据与待确认项。', x: 100, y: 100, w: 240 };
  const b = { id: 'n_flow002', type: 'text', markdown: '由人决定', x: 400, y: 400, w: 240 };
  const edge = { id: 'e_flow001', kind: 'association', from: a.id, to: b.id, directed: true, label: '已厘清' };
  assert.equal((await apply(store, [a, b].map(node => ({ op: 'addNode', node, before: null, after: node })).concat([{ op: 'addEdge', edge, before: null, after: edge }]))).ok, true);
  return { a, b, edge };
}

test('AI appearance batches survive persistence and undo without changing the knowledge or relation', async t => {
  const { store, directory } = await fixture(t), { a, edge } = await seed(store);
  assert.equal((await apply(store, [
    { op: 'setNodeShape', nodeId: a.id, before: null, after: { shape: 'diamond' } },
    { op: 'setEdgeStyle', edgeId: edge.id, before: null, after: { routing: 'orthogonal', stroke: 'solid' } },
  ])).ok, true);
  const resumed = new BoardStore(directory); await resumed.ready;
  const current = await resumed.read();
  assert.deepEqual(current.nodes[0], { ...a, shape: 'diamond' });
  assert.deepEqual(current.edges[0], { ...edge, routing: 'orthogonal', stroke: 'solid' });
  assert.match(current.operations, /setNodeShape/); assert.match(current.operations, /setEdgeStyle/);
  const file = parseBoard(Buffer.from((await resumed.snapshot()).data, 'base64')).file;
  assert.equal(file.formatVersion, '3.0');
  assert.equal((await apply(resumed, invertOps(file.history.at(-1).ops))).ok, true);
  assert.deepEqual((await resumed.read()).nodes[0], a);
  assert.deepEqual((await resumed.read()).edges[0], edge);
});

test('an invalid appearance batch cannot publish a partial update or change revision', async t => {
  const { store } = await fixture(t), { a, edge } = await seed(store);
  const before = await store.snapshot();
  assert.equal((await apply(store, [
    { op: 'setNodeShape', nodeId: a.id, before: null, after: { shape: 'diamond' } },
    { op: 'setEdgeStyle', edgeId: edge.id, before: null, after: { routing: 'orthogonal', stroke: 'solid', label: '越界改写' } },
  ])).ok, false);
  assert.deepEqual(await store.snapshot(), before);
});
