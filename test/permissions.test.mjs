import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardPermissions } from '../src/permissions.mjs';
import { createPermissionClient } from '../src/permission-client.mjs';
import { associatedSession } from '../src/submission.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-board-permissions-'));
  const permissions = new BoardPermissions(join(directory, 'policy.json')); await permissions.ready;
  t.after(async () => { permissions.dispose(); await permissions.tail.catch(() => {}); assert.equal(dirname(directory),tmpdir()); assert.ok(basename(directory).startsWith('dsh-board-permissions-')); await rm(directory,{recursive:true,force:true}); });
  return permissions;
}
const agent = {id:'chat-A'}, message = rpcId => ({source:{kind:'user',rpcId}});
async function stage(p, id, sessionId=agent.id) {
  const choice=p.choice(sessionId); await p.stage(sessionId,id,{version:1,mode:choice.mode},choice.revision);
}
async function select(p, mode, sessionId=agent.id) {return p.configure({sessionId,mode,revision:p.choice(sessionId).revision});}

test('one response stays read-only after acceptance resets the composer; duplicate receipts consume only once', async t => {
  const p=await fixture(t); await select(p,'chat_once'); await stage(p,'once');
  assert.equal(p.choice(agent.id).mode,'chat_once','staging is not admission');
  assert.equal(p.accept(agent.id,'once'),true); assert.equal(p.choice(agent.id).mode,'auto');
  const revision=p.choice(agent.id).revision; assert.equal(p.accept(agent.id,'once'),false); assert.equal(p.choice(agent.id).revision,revision);
  p.claim(agent,message('once'),1); assert.equal(p.canWrite(agent),false); assert.throws(()=>p.writer(agent),{code:'E_BOARD_READ_ONLY'});
  await stage(p,'next'); p.claim(agent,message('next'),2); assert.equal(p.canWrite(agent),true);
});
test('refused and uncertain sends preserve the once choice; an old receipt cannot erase a newer choice', async t => {
  const p=await fixture(t); await select(p,'chat_once'); await stage(p,'refused'); await p.discard(agent.id,'refused');
  assert.equal(p.choice(agent.id).mode,'chat_once'); await stage(p,'uncertain');
  await select(p,'chat_continuous'); p.accept(agent.id,'uncertain'); assert.equal(p.choice(agent.id).mode,'chat_continuous');
  await select(p,'chat_once'); await stage(p,'old'); await select(p,'auto'); await select(p,'chat_once');
  p.accept(agent.id,'old'); assert.equal(p.choice(agent.id).mode,'chat_once','same label with a newer choice revision is a new intention');
  assert.equal(p.state.messages[`${agent.id}:uncertain`].permission.mode,'chat_once');
});
test('continuous chat mode and queued snapshots are session-owned and durable across host restart', async t => {
  const p=await fixture(t); await select(p,'chat_continuous'); await stage(p,'queued');
  await select(p,'auto'); await stage(p,'later'); await select(p,'chat_continuous');
  await p.save(); const restored=new BoardPermissions(p.path); await restored.ready;
  t.after(()=>restored.dispose()); assert.equal(restored.choice(agent.id).mode,'chat_continuous'); assert.equal(restored.choice('chat-B').mode,'auto');
  restored.claim(agent,message('queued'),1); assert.equal(restored.canWrite(agent),false);
  restored.claim(agent,message('later'),2); assert.equal(restored.canWrite(agent),true,'queued messages use their own frozen policy');
  await restored.save(); const resumed=new BoardPermissions(p.path); await resumed.ready; t.after(()=>resumed.dispose());
  assert.equal(resumed.canWrite(agent),true); assert.equal(resumed.writer(agent).aborted,false,'approval continuation retains a proven grant');
});
test('read-only steer revokes in-flight grants and remains sticky through auto steer in the same native turn', async t => {
  const p=await fixture(t); await stage(p,'auto'); p.claim(agent,message('auto'),4); const grant=p.writer(agent);
  await select(p,'chat_once'); await stage(p,'steer'); p.claim(agent,message('steer'),4);
  assert.equal(grant.aborted,true); assert.equal(grant.reason.code,'E_BOARD_READ_ONLY');
  await stage(p,'auto-steer'); p.claim(agent,message('auto-steer'),4); assert.equal(p.canWrite(agent),false);
  await stage(p,'new-turn'); p.claim(agent,message('new-turn'),5); assert.equal(p.canWrite(agent),true); assert.equal(p.writer(agent).aborted,false);
});
test('unknown/invalid permissions never grant writing, including after selecting auto for a future message', async t => {
  const p=await fixture(t); assert.equal(p.canWrite(agent),false);
  p.claim(agent,message('not-staged'),1); await select(p,'auto'); assert.equal(p.canWrite(agent),false);
  for(const value of [{mode:'auto'},{version:2,mode:'auto'},{version:1,mode:'auto',extra:true},{version:1,mode:'yes'}])
    await assert.rejects(p.stage(agent.id,'bad',value,0),/非法/);
  await assert.rejects(p.stage('__proto__','bad',{version:1,mode:'auto'},0),/非法/);
  await stage(p,'fixed'); await assert.rejects(p.stage(agent.id,'fixed',{version:1,mode:'chat_once'},0),/不能改写/);
  await assert.rejects(p.configure({sessionId:agent.id,mode:'auto',revision:-1}),{code:'E_PERMISSION_CONFLICT'});
});
test('a native claim consumes a lost-response admission without permitting its read-only response', async t => {
  const p=await fixture(t); await select(p,'chat_once'); await stage(p,'lost');
  p.claim(agent,message('lost'),1); assert.equal(p.choice(agent.id).mode,'auto'); assert.equal(p.canWrite(agent),false);
  await p.discard(agent.id,'lost'); assert.ok(p.state.messages[`${agent.id}:lost`],'late refusal cleanup cannot erase a proven admission');
});
test('submission captures a choice before asynchronous preparation and acknowledgement failure cannot duplicate the message', async () => {
  let selected={version:1,mode:'chat_once',revision:1},receiptCalls=0;
  const client=createPermissionClient(async(path,body)=>{
    if(path.startsWith('permissions?')) return selected;
    if(path==='permissions/accepted') {receiptCalls++; throw new Error('disconnected');}
    selected={...selected,mode:body.mode,revision:selected.revision+1}; return selected;
  });
  await client.get(agent.id); const frozen=await client.snapshot(agent.id); await client.change(agent.id,'auto');
  assert.equal(frozen.mode,'chat_once'); assert.equal((await client.snapshot(agent.id)).mode,'auto');
  let prompts=0;
  const wrapped=associatedSession({sessionId:agent.id,prompt:async()=>{prompts++;return{ok:true};}},null,
    {stage:async()=>{},discard:async()=>assert.fail('accepted prompt is not refused'),accepted:(...args)=>client.accepted(...args)});
  assert.equal((await wrapped.prompt([],'queue',new AbortController().signal,'message')).ok,true);
  assert.equal(prompts,1); assert.equal(receiptCalls,1);
});
test('an older permission poll cannot overwrite a newer user choice', async () => {
  let release;const waiting=new Promise(resolve=>{release=resolve;});let reads=0;
  const client=createPermissionClient(async(path)=>{
    if(path.startsWith('permissions?')) {if(reads++===0)return{version:1,mode:'auto',revision:0};await waiting;return{version:1,mode:'auto',revision:0};}
    return{version:1,mode:'chat_continuous',revision:1};
  });
  await client.get(agent.id);const poll=client.get(agent.id);await client.change(agent.id,'chat_continuous');release();await poll;
  assert.equal(client.peek(agent.id).mode,'chat_continuous');
});
