import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSession, LAYOUT_REQUEST } from '../src/layout-submission.mjs';
import { LayoutTasks } from '../src/layout.mjs';

test('restored toolbar messages without a snapshot remain closed to generic tools',()=>{
  const tasks=new LayoutTasks({}),agent={id:'session1'};
  tasks.claim(agent,{source:{kind:'user',rpcId:'old-request'},content:[{type:'text',text:LAYOUT_REQUEST}]});
  assert.equal(tasks.forAgent(agent).status,'failed');
  tasks.settle(agent);assert.equal(tasks.forAgent(agent),undefined);
});
test('layout metadata is bound to native admission without injecting card contents into text', async () => {
    const events = [], signal = new AbortController().signal;
    const session = { sessionId: 'session1', prompt: async (content, mode, receivedSignal, requestId) => { events.push({ content, mode, receivedSignal, requestId }); return { ok: true }; } };
    const snapshot = { boardId: 'b_layout01', nodeIds: ['n_layout01'], geometry: { n_layout01: { w: 100, h: 70 } } };
    const bound = layoutSession(session, snapshot, { stage: async (value, receivedSignal) => { assert.equal(receivedSignal, signal); events.push(value); return { id: 'task1' }; }, accepted: task => events.push(task), cancel: () => assert.fail('successful admission must not be cancelled') });
    const content = [{ type: 'text', text: '整理白板布局' }];
    await bound.prompt(content, 'queue', signal, 'request1');
    assert.deepEqual(events[0], { ...snapshot, sessionId: 'session1', requestId: 'request1' });
    assert.equal(events[1].content, content);
    assert.equal(events[1].requestId, 'request1');
    assert.deepEqual(events[2], { id: 'task1' });
});
test('admission refusal cancels the pending task; lost response preserves its identity', async () => {
    const cancelled = [];
    const refused = layoutSession({ sessionId: 'session1', prompt: async () => ({ ok: false }) }, {}, { stage: async () => ({ id: 'task1' }), cancel: async (id) => cancelled.push(id) });
    await refused.prompt([], 'queue');
    assert.deepEqual(cancelled, ['task1']);
    let uncertain;
    const lost = layoutSession({ sessionId: 'session1', prompt: async () => { throw new Error('lost'); } }, {}, { stage: async () => ({ id: 'task2' }), cancel: () => assert.fail('must not guess admission failed'), uncertain: task => uncertain = task });
    await assert.rejects(lost.prompt([], 'queue'), /lost/);
    assert.deepEqual(uncertain, { id: 'task2' });
});
