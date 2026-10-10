import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { apply } from '../src/host.mjs';

test('host uses fixed prompt tail and runtime context; management disables tools without deleting draft', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-board-host-'));
  const routes = new Map(), tools = new Map(), sections = new Map(), contexts = new Map(), events = new Map(), releases = [];
  const entry = map => value => { assert.ok(!map.has(value.name)); map.set(value.name, value); return () => map.delete(value.name); };
  const ctx = {
    effect: create => releases.push(create()),
    on: (name, handler) => events.set(name, handler), logger: { warn() {} },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: entry(tools) },
    systemPrompt: { section: entry(sections), context: entry(contexts), getSectionOrder: name => { assert.equal(name, 'DEPLOYMENT_PERSONA_SUFFIX'); return 10200; } },
  };
  t.after(async () => { for (const release of releases.toReversed()) release?.(); assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-host-')); await rm(directory, { recursive: true, force: true }); });
  await apply(ctx, { dataDir: directory });
  const post = (path, body) => routes.get('/api/dsh-board/' + path).fetch(new Request('http://localhost/api/dsh-board/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const before = await tools.get('draft_board_read').execute();
  const prompt = sections.get('dsh-board');
  assert.ok(prompt.order > 10200); assert.equal(typeof prompt.text, 'string');
  assert.equal(contexts.get('dsh-board').order, 1_000_000);
  await post('association', { sessionId: 'session1', requestId: 'request1', selection: { boardId: before.board.id, cards: [{ id: 'n_card001', title: 'A' }] } });
  events.get('agent/inbox/claimed')({ agent: { id: 'session1' }, message: { source: { kind: 'user', rpcId: 'request1' } } });
  assert.ok(contexts.get('dsh-board').text({ agent: { id: 'session1' } }).includes('n_card001'));
  assert.equal((await post('options', { associateSelection: false })).status, 200);
  assert.equal(sections.get('dsh-board'), prompt, 'association preferences do not re-register stable instructions');
  assert.ok(!contexts.get('dsh-board').text({ agent: { id: 'session1' } }).includes('n_card001'));
  const read = tools.get('draft_board_read');
  assert.equal((await post('options', { enabled: false })).status, 200);
  assert.equal(tools.size, 0); assert.equal(sections.size, 0); assert.equal(contexts.size, 0);
  await assert.rejects(read.execute(), /disabled/);
  assert.equal((await post('options', { enabled: true })).status, 200);
  assert.equal((await tools.get('draft_board_read').execute()).board.id, before.board.id);
});
