import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { apply } from '../src/host.mjs';
import { BoardStore } from '../src/store.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-board-permission-host-'));
  const routes=new Map(),tools=new Map(),events=new Map(),contexts=new Map(),releases=[];
  let guard;
  await apply({effect:fn=>releases.push(fn()),on:(name,fn)=>events.set(name,fn),logger:{warn(){}},
    connection:{fetch:{register:route=>{routes.set(route.path,route);return()=>{};}}},
    tools:{register:def=>{tools.set(def.name,def);return()=>tools.delete(def.name);},guard:fn=>{guard=fn;return()=>{};}},
    systemPrompt:{section:()=>()=>{},context:def=>{contexts.set(def.name,def);return()=>{};},getSectionOrder:()=>10200}}, {dataDir:directory});
  const call=async(path,body,method=body?'POST':'GET')=>{
    const request=new Request('http://localhost/api/dsh-board/'+path,{method,...body?{body:JSON.stringify(body)}:{}});
    const response=await routes.get('/api/dsh-board/'+path.split('?')[0]).fetch(request);
    return {status:response.status,value:await response.json()};
  };
  const masks=[];
  const agent={id:'chat-A',ctx:{tools:{restrict:filter=>{for(const name of filter.deny ?? [])assert.ok(tools.has(name),'native restrictions require registered tools');masks.push(filter);return()=>{};}}}};
  const claim=(id,turn)=>events.get('agent/inbox/claimed')({agent,message:{source:{kind:'user',rpcId:id}},turn});
  const choose=async mode=>{
    const {value}=await call('permissions?sessionId='+agent.id);
    return call('permissions',{sessionId:agent.id,mode,revision:value.revision});
  };
  const stage=async id=>{
    const {value}=await call('permissions?sessionId='+agent.id);
    assert.equal((await call('association',{sessionId:agent.id,requestId:id,permission:{version:1,mode:value.mode},permissionRevision:value.revision})).status,200);
  };
  const snapshot=async()=> (await call('state')).value;
  const bytes=async()=>{const pointer=JSON.parse(await readFile(join(directory,'current.json'),'utf8'));return readFile(join(directory,'boards',pointer.file));};
  const submit=async()=>{
    const read=await tools.get('draft_board_read').execute();
    const node={id:'n_allowed01',type:'text',markdown:'合成测试',x:0,y:0,w:100,h:70};
    return tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:read.board.id,baseContentVersion:read.board.contentVersion,actor:'agent',label:'权限回归',ops:[{op:'addNode',node,before:null,after:node}]})},{agent,signal:new AbortController().signal});
  };
  const pending=async()=>{for(let i=0;i<100;i++){const {value}=await call('quality');if(value.job)return value.job;await new Promise(r=>setTimeout(r,5));}assert.fail('no render job');};
  t.after(async()=>{for(const release of releases.toReversed())await release?.();assert.equal(dirname(directory),tmpdir());assert.ok(basename(directory).startsWith('dsh-board-permission-host-'));await rm(directory,{recursive:true,force:true});});
  return {directory,tools,call,agent,claim,choose,stage,snapshot,bytes,submit,pending,masks,guard:exec=>guard(exec),contexts};
}

test('read-only is enforced by tool masks, guard and handler while reads, unrelated tools and human sync remain available',async t=>{
  const f=await fixture(t); await f.call('options',{associateSelection:false});
  await f.choose('chat_once');await f.stage('readonly');f.claim('readonly',1);
  const original=await f.bytes(),before=await f.snapshot();
  assert.equal((await f.submit()).error.code,'E_BOARD_READ_ONLY');
  assert.match(f.guard({agent:f.agent,name:'draft_board_apply'}),/E_BOARD_READ_ONLY/);
  assert.match(f.guard({agent:f.agent,name:'draft_board_layout_apply'}),/E_BOARD_READ_ONLY/);
  assert.equal(f.guard({agent:f.agent,name:'run_code'}),undefined,'transport is allowed, nested end tools still guarded');
  assert.equal(f.guard({agent:f.agent,name:'pwsh'}),undefined,'other work remains available');
  assert.deepEqual(f.masks.at(-1).deny,['draft_board_apply','draft_board_layout_apply']);
  assert.equal((await f.tools.get('draft_board_layout_apply').execute({}, {agent:f.agent})).error.code,'E_BOARD_READ_ONLY');
  assert.match(f.contexts.get('dsh-board').text({agent:f.agent}),/read_only/);
  assert.equal((await f.call('permissions?sessionId=chat-A')).value.mode,'auto','accepted claim consumes one-shot mode');
  assert.deepEqual(await f.bytes(),original);assert.equal((await f.snapshot()).revision,before.revision);
  assert.equal((await f.call('sync',{revision:before.revision,data:before.data})).status,200,'human sync is still permitted');
  await f.choose('chat_continuous');
  assert.equal((await f.call('layout',{sessionId:'chat-A',requestId:'layout'})).status,403);
  await f.call('options',{enabled:false});await f.stage('while-disabled');f.claim('while-disabled',2);
  assert.equal(f.tools.size,0,'native inbox events still work while plugin tools are unregistered');
  await f.call('options',{enabled:true});assert.deepEqual(f.masks.at(-1).deny,['draft_board_apply','draft_board_layout_apply']);
  assert.equal((await f.submit()).error.code,'E_BOARD_READ_ONLY','re-enabling restores the current response permission');
});
test('read-only steer cancels a candidate waiting for measurement and auto steer cannot revive it',async t=>{
  const f=await fixture(t);await f.stage('auto');f.claim('auto',1);
  const before=await f.bytes();const writing=f.submit();const job=await f.pending();
  await f.choose('chat_once');await f.stage('readonly');f.claim('readonly',1);
  assert.equal((await writing).error.code,'E_BOARD_READ_ONLY');
  assert.equal((await f.call('quality',{id:job.id})).value.accepted,false);
  await f.stage('auto-steer');f.claim('auto-steer',1);
  assert.equal((await f.submit()).error.code,'E_BOARD_READ_ONLY');
  assert.deepEqual(await f.bytes(),before);assert.equal((await f.tools.get('draft_board_read').execute()).nodes.length,0);
});
test('a permission change after measurement is rechecked before the atomic disk commit',async t=>{
  const f=await fixture(t);await f.stage('auto');f.claim('auto',3);
  const before=await f.bytes(),persist=BoardStore.prototype.persist;
  let reached,unlock;const held=new Promise(r=>{reached=r;});const wait=new Promise(r=>{unlock=r;});
  BoardStore.prototype.persist=async function(...args){if(this.directory===f.directory){reached();await wait;}return persist.apply(this,args);};
  t.after(()=>{BoardStore.prototype.persist=persist;unlock();});
  const writing=f.submit();const job=await f.pending();
  await f.call('quality',{id:job.id,before:{geometry:{},labels:{}},after:{geometry:{n_allowed01:{w:100,h:70}},labels:{}}});
  await held;await f.choose('chat_once');await f.stage('steer');f.claim('steer',3);unlock();
  assert.equal((await writing).error.code,'E_BOARD_READ_ONLY');assert.deepEqual(await f.bytes(),before);
});
