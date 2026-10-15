import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    tools: { register: entry(tools), guard: () => () => {} },
    systemPrompt: { section: entry(sections), context: entry(contexts), getSectionOrder: name => { assert.equal(name, 'DEPLOYMENT_PERSONA_SUFFIX'); return 10200; } },
  };
  t.after(async () => { for (const release of releases.toReversed()) release?.(); assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-host-')); await rm(directory, { recursive: true, force: true }); });
  await apply(ctx, { dataDir: directory });
  const post = (path, body) => routes.get('/api/dsh-board/' + path).fetch(new Request('http://localhost/api/dsh-board/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const before = await tools.get('draft_board_read').execute();
  const prompt = sections.get('dsh-board');
  assert.ok(prompt.order > 10200); assert.equal(typeof prompt.text, 'string');
  const guideRoute=routes.get('/api/dsh-board/guide');
  const guideRead=async()=> (await guideRoute.fetch(new Request('http://localhost/api/dsh-board/guide'))).json();
  const initialGuide=await guideRead();
  assert.equal(sections.get('dsh-board-guide').text,initialGuide.text,'user-visible file is the injected guide');
  const stableReadTool=tools.get('draft_board_read');
  const customGuide=await (await post('guide',{revision:initialGuide.revision,text:'核心只写结论，解释放备注。'})).json();
  assert.equal(sections.get('dsh-board-guide').text,customGuide.text);
  assert.equal(sections.get('dsh-board'),prompt,'guide edits do not change fixed collaboration rules');
  assert.equal(tools.get('draft_board_read'),stableReadTool,'guide edits do not replace stable tools');
  const guideSection=sections.get('dsh-board-guide');await guideRead();
  assert.equal(sections.get('dsh-board-guide'),guideSection,'unchanged guide does not re-register prompt');
  assert.equal((await post('guide',{revision:initialGuide.revision,text:'stale'})).status,409);
  await writeFile(initialGuide.path,'父子卡表达层级；集合表达并列。','utf8');
  const externalGuide=await guideRead();assert.equal(sections.get('dsh-board-guide').text,externalGuide.text);
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
  assert.equal((await post('guide',{revision:externalGuide.revision,text:'关闭期间仍可编辑方法。'})).status,200);
  assert.equal(sections.size,0,'editing a disabled plugin does not enable prompt injection');
  assert.equal((await post('options', { enabled: true })).status, 200);
  assert.equal(sections.get('dsh-board-guide').text,'关闭期间仍可编辑方法。');
  assert.equal((await tools.get('draft_board_read').execute()).board.id, before.board.id);
});

test('native layout claim narrows tools for exactly one agent turn and restores normal editing on idle',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dsh-board-host-'));
  const routes=new Map(),tools=new Map(),contexts=new Map(),events=new Map(),releases=[];
  let guard,restricted=false;
  const ctx={effect:create=>releases.push(create()),on:(name,fn)=>events.set(name,fn),logger:{warn(){}},
    connection:{fetch:{register:route=>{routes.set(route.path,route);return ()=>{};}}},
    tools:{register:definition=>{tools.set(definition.name,definition);return ()=>tools.delete(definition.name);},guard:fn=>{guard=fn;return ()=>{};}},
    systemPrompt:{section:()=>()=>{},context:value=>{contexts.set(value.name,value);return ()=>contexts.delete(value.name);},getSectionOrder:()=>10200}};
  t.after(async()=>{for(const release of releases.toReversed())release?.();assert.equal(dirname(directory),tmpdir());assert.ok(basename(directory).startsWith('dsh-board-host-'));await rm(directory,{recursive:true,force:true});});
  await apply(ctx,{dataDir:directory});
  const initial=await tools.get('draft_board_read').execute();
  const node={id:'n_layout01',type:'text',markdown:'前提',x:0,y:0,w:100,h:70};
  await tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:initial.board.id,baseContentVersion:initial.board.contentVersion,actor:'agent',label:'示例',ops:[{op:'addNode',node,before:null,after:node}]})},{signal:new AbortController().signal});
  const read=await tools.get('draft_board_read').execute();
  const input={sessionId:'session1',requestId:'request1',boardId:read.board.id,baseContentVersion:read.board.contentVersion,revision:read.revision,geometry:{n_layout01:{w:100,h:70}},viewport:{width:1200,height:800},nodeIds:['n_layout01']};
  const response=await routes.get('/api/dsh-board/layout').fetch(new Request('http://localhost/api/dsh-board/layout',{method:'POST',body:JSON.stringify(input)}));
  const task=await response.json();assert.equal(response.status,200);
  const agent={id:'session1',ctx:{tools:{restrict:filter=>{assert.deepEqual(filter.allow,['draft_board_layout_read','draft_board_layout_apply']);restricted=true;return ()=>{restricted=false;};}}}};
  const exec={agent,signal:new AbortController().signal};
  assert.equal((await tools.get('draft_board_layout_read').execute({},exec)).ok,false);
  events.get('agent/inbox/claimed')({agent,message:{source:{kind:'user',rpcId:'request1'}}});
  assert.ok(restricted);assert.match(contexts.get('dsh-board').text({agent}),/视觉风格/);
  assert.ok(guard({agent,name:'draft_board_apply'}));assert.ok(guard({agent,name:'pwsh'}));
  assert.equal(guard({agent,name:'draft_board_layout_apply'}),undefined);
  assert.equal(guard({agent:{id:'session2'},name:'draft_board_apply'}),undefined);
  assert.equal((await tools.get('draft_board_layout_read').execute({},exec)).taskId,task.id);
  assert.equal((await tools.get('draft_board_layout_apply').execute({taskId:task.id,boardId:read.board.id,baseContentVersion:read.board.contentVersion,positions:[{nodeId:node.id,x:120,y:60}]},exec)).ok,true);
  assert.ok(guard({agent,name:'draft_board_apply'}),'completed candidate still restricts the rest of this turn');
  events.get('agent/status')({agent,status:'idle'});
  assert.equal(restricted,false);assert.equal(guard({agent,name:'draft_board_apply'}),undefined);
  assert.ok(!contexts.get('dsh-board').text({agent}).includes('视觉风格'));
});
