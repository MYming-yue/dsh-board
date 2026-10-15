import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardStore } from '../src/store.mjs';
import { LayoutTasks } from '../src/layout.mjs';

test('cancellation while awaiting disk commit leaves the board untouched',async t=>{
    const {store,layouts,args,exec,task}=await fixture(t),before=await store.snapshot();
    let unblock,entered;
    const gate=new Promise(resolve=>unblock=resolve),started=new Promise(resolve=>entered=resolve),atomic=store.atomic.bind(store);
    store.atomic=async(...args)=>{if(args[0].endsWith('.draft')){entered();await gate;}return atomic(...args);};
    const submission=layouts.apply({...args,positions:[{nodeId:'n_layout02',x:500,y:100}]},exec);
    await started;layouts.cancel(task.id);unblock();
    await assert.rejects(submission,error=>error.name==='AbortError');
    assert.deepEqual(await store.snapshot(),before);
});
async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-board-layout-'));
    t.after(async () => { assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-layout-')); await rm(directory, { recursive: true, force: true }); });
    const store = new BoardStore(directory);
    await store.ready;
    const read = await store.read();
    const nodes = [{ id: 'n_layout01', type: 'text', markdown: '前提', x: 0, y: 0, w: 100, h: 70 }, { id: 'n_layout02', type: 'text', markdown: '结论', x: 300, y: 0, w: 100, h: 70 }];
    assert.ok((await store.apply({ batchVersion: '1.0', boardId: read.board.id, baseContentVersion: read.board.contentVersion, actor: 'agent', label: '示例', ops: nodes.map(node => ({ op: 'addNode', node, after: node, before: null })) })).ok);
    const state = await store.read(), layouts = new LayoutTasks(store), agent = { id: 'session1' };
    const input = { sessionId: agent.id, requestId: 'request1', boardId: state.board.id, baseContentVersion: state.board.contentVersion, revision: state.revision, geometry: Object.fromEntries(nodes.map(n => [n.id, { w: 100, h: 70 }])), viewport: { width: 1200, height: 800 }, nodeIds: nodes.map(n => n.id) };
    const task = await layouts.create(input);
    const claim = () => layouts.claim(agent, { source: { kind: 'user', rpcId: 'request1' } });
    claim();
    const args = { taskId: task.id, boardId: state.board.id, baseContentVersion: state.board.contentVersion, positions: [] };
    const exec = { agent, signal: new AbortController().signal };
    return { store, layouts, agent, input, args, exec, claim, task };
}
test('only scoped position changes are accepted; collision candidates never change disk or history', async (t) => {
    const { store, layouts, args, exec } = await fixture(t), before = await store.snapshot();
    assert.equal((await layouts.apply({ ...args, ops: [{ op: 'removeNode' }] }, exec)).ok, false);
    assert.equal((await layouts.apply({ ...args, positions: [{ nodeId: 'n_missing1', x: 10, y: 10 }] }, exec)).ok, false);
    const collision = await layouts.apply({ ...args, positions: [{ nodeId: 'n_layout02', x: 20, y: 0 }] }, exec);
    assert.equal(collision.error.code, 'E_LAYOUT_GEOMETRY');
    assert.deepEqual(await store.snapshot(), before);
});
test('one successful candidate commits one history step and leaves content and structure intact', async (t) => {
    const { store, layouts, args, exec } = await fixture(t), before = structuredClone(store.bundle.file);
    const result = await layouts.apply({ ...args, positions: [{ nodeId: 'n_layout02', x: 420, y: 120 }] }, exec);
    assert.equal(result.ok, true);
    assert.equal(result.moved, 1);
    assert.equal(store.bundle.file.history.length, before.history.length + 1);
    assert.deepEqual(store.bundle.file.nodes.map(({ x, y, ...rest }) => rest), before.nodes.map(({ x, y, ...rest }) => rest));
    assert.deepEqual(store.bundle.file.edges, before.edges);
    assert.equal((await layouts.apply(args, exec)).ok, false, 'a completed task cannot commit again');
});
test('no-op has no history; cancelled queued tasks remain restricted when claimed', async (t) => {
    const { store, layouts, args, exec, task, claim } = await fixture(t), before = await store.snapshot();
    layouts.cancel(task.id);
    claim();
    assert.ok(layouts.forAgent(exec.agent));
    assert.equal((await layouts.apply(args, exec)).ok, false);
    assert.deepEqual(await store.snapshot(), before);
    layouts.settle(exec.agent);
    assert.equal(layouts.forAgent(exec.agent), undefined);
});
test('empty positions finish without incrementing version', async (t) => {
    const { store, layouts, args, exec } = await fixture(t), before = await store.snapshot();
    assert.equal((await layouts.apply(args, exec)).ok, true);
    assert.deepEqual(await store.snapshot(), before);
});
test('concurrent board updates and presentation changes reject stale layouts', async (t) => {
    const { store, layouts, args, exec, input, task } = await fixture(t);
    layouts.observe({ id: task.id, geometry: { ...input.geometry, n_layout01: { w: 100, h: 170 } }, viewport: input.viewport });
    assert.equal((await layouts.apply(args, exec)).ok, false);
    const before = await store.snapshot();
    layouts.active.clear();
    const next = await layouts.create({ ...input, requestId: 'request2' });
    layouts.claim(exec.agent, { source: { kind: 'user', rpcId: 'request2' } });
    const file = store.bundle.file;
    await store.apply({ batchVersion: '1.0', boardId: file.board.id, baseContentVersion: file.board.contentVersion, actor: 'agent', label: '并行修改', ops: [{ op: 'updateNodeText', nodeId: 'n_layout01', before: null, after: { markdown: '新前提' } }] });
    assert.equal((await layouts.apply({ ...args, taskId: next.id }, exec)).error.code, 'E_VERSION_CONFLICT');
    assert.notDeepEqual(await store.snapshot(), before);
    assert.equal((await store.read()).nodes[0].markdown, '新前提');
});
test('local layout cannot move unselected cards and retries have a strict limit', async (t) => {
    const { store, layouts, args, exec, input, task } = await fixture(t);
    layouts.cancel(task.id);
    layouts.active.clear();
    const local = await layouts.create({ ...input, requestId: 'request2', nodeIds: ['n_layout01'] });
    layouts.claim(exec.agent, { source: { kind: 'user', rpcId: 'request2' } });
    const before = await store.snapshot();
    assert.equal((await layouts.apply({ ...args, taskId: local.id, positions: [{ nodeId: 'n_layout02', x: 800, y: 0 }] }, exec)).ok, false);
    for (let i = 0; i < 2; i++)
        assert.equal((await layouts.apply({ ...args, taskId: local.id, positions: [{ nodeId: 'n_layout01', x: 300, y: 0 }] }, exec)).error.code, 'E_LAYOUT_GEOMETRY');
    assert.equal(layouts.get(local.id).status, 'failed');
    assert.deepEqual(await store.snapshot(), before);
});
