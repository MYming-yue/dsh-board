import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { BoardStore } from '../src/store.mjs';
import { QualityReview } from '../src/quality.mjs';
import { parseBoard, serializeBoard, createEmptyBoard } from '../lib/model.js';

const node=(id,x=0,y=0)=>({id,type:'text',markdown:id,x,y,w:100,h:70});
const add=n=>({op:'addNode',node:n,before:null,after:n});
const batch=(read,ops)=>({batchVersion:'1.0',boardId:read.board.id,baseContentVersion:read.board.contentVersion,actor:'agent',label:'预检回归',ops});
const measure=data=>({geometry:Object.fromEntries(parseBoard(Buffer.from(data,'base64')).file.nodes.map(n=>[n.id,{w:n.w,h:n.h ?? 70}])),labels:{}});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-board-quality-'));
  const quality=new QualityReview({timeoutMs:1000}),store=new BoardStore(directory,quality);await store.ready;
  t.after(async()=>{quality.setEnabled(false);assert.equal(dirname(directory),tmpdir());assert.ok(basename(directory).startsWith('dsh-board-quality-'));await rm(directory,{recursive:true,force:true});});
  return {store,quality};
}
async function pending(quality) {
  for(let i=0;i<100;i++){if(quality.pending())return quality.pending();await new Promise(r=>setTimeout(r,5));}
  assert.fail('No render job');
}
async function report(quality,custom) {
  const job=await pending(quality);
  quality.report({id:job.id,before:measure(job.before),after:custom ?? measure(job.data)});
}
test('overlapping new cards are refused before disk/version/history changes, and a corrected full batch succeeds',async t=>{
  const {store,quality}=await fixture(t),before=await store.snapshot(),read=await store.read();
  const originalBytes=await readFile(join(store.directory,'boards',store.file));
  const bad=store.apply(batch(read,[add(node('n_check01')),add(node('n_check02',20))]));
  await report(quality);const result=await bad;
  assert.equal(result.error.code,'E_EDIT_GEOMETRY');assert.ok(result.conflicts.some(c=>c.kind==='card'));
  assert.equal((await store.snapshot()).revision,before.revision);assert.deepEqual(await readFile(join(store.directory,'boards',store.file)),originalBytes);assert.equal(store.bundle.file.history.length,0);
  const good=store.apply(batch(read,[add(node('n_check01')),add(node('n_check02',300))]));
  await report(quality);assert.equal((await good).ok,true);
  assert.equal(store.bundle.file.history.length,1);assert.equal((await store.read()).layout.status,'measured');
});
test('actual expanded caption and shape dimensions override small saved sizes',async t=>{
  const {store,quality}=await fixture(t),read=await store.read();
  const change=store.apply(batch(read,[add({...node('n_check01'),caption:'解释',shape:'diamond'}),add(node('n_check02',180))]));
  await report(quality,{geometry:{n_check01:{w:300,h:400},n_check02:{w:100,h:70}},labels:{}});
  const out=await change;assert.equal(out.error.code,'E_EDIT_GEOMETRY');assert.equal(out.geometry.n_check01.h,400);
});
test('disjoint group envelopes are checked even when cards have clear gaps',async t=>{
  const {store,quality}=await fixture(t),read=await store.read(),nodes=[node('n_check01'),node('n_check02',150)];
  const groups=nodes.map((n,i)=>({id:`g_check0${i}`,name:'分组',shape:'rectangle',nodeIds:[n.id],x:n.x,y:n.y}));
  const change=store.apply(batch(read,[...nodes.map(add),...groups.map(c=>({op:'addCollection',collection:c,before:null,after:c}))]));
  await report(quality);assert.ok((await change).conflicts.some(c=>c.kind==='collection-overlap'));
});
test('unrelated old overlaps remain editable; changing either conflicting card must resolve its collision',async t=>{
  const {store,quality}=await fixture(t),initial=await store.snapshot(),file=createEmptyBoard('旧布局');
  file.nodes=[node('n_check01'),node('n_check02',20)];
  await store.sync({revision:initial.revision,data:Buffer.from(serializeBoard(file,{})).toString('base64'),replace:true});
  let read=await store.read(),change=store.apply(batch(read,[add(node('n_check03',500))]));
  await report(quality);assert.equal((await change).ok,true);
  read=await store.read();change=store.apply(batch(read,[{op:'moveNode',nodeId:'n_check02',before:null,after:{x:25,y:0}}]));
  await report(quality);assert.equal((await change).error.code,'E_EDIT_GEOMETRY');
});
test('human edits proceed during measurement; stale render results cannot overwrite them',async t=>{
  const {store,quality}=await fixture(t),read=await store.read();
  const change=store.apply(batch(read,[add(node('n_check01'))]));const job=await pending(quality);
  const current=await store.snapshot(),bundle=parseBoard(Buffer.from(current.data,'base64'));bundle.file.board.name='人的修改';
  await store.sync({...current,data:Buffer.from(serializeBoard(bundle.file,bundle.blobs)).toString('base64')});
  quality.report({id:job.id,before:measure(job.before),after:measure(job.data)});
  assert.equal((await change).error.code,'E_VERSION_CONFLICT');assert.equal((await store.read()).board.name,'人的修改');
  assert.equal((await store.read()).nodes.length,0);
});
test('cancel, disable, timeout, and malformed or stale measurement never publish a candidate',async t=>{
  const {store,quality}=await fixture(t),read=await store.read(),before=await store.snapshot();
  const originalBytes=await readFile(join(store.directory,'boards',store.file));
  const controller=new AbortController();
  const change=store.apply(batch(read,[add(node('n_check01'))]),controller.signal);const job=await pending(quality);
  assert.throws(()=>quality.report({id:job.id,before:measure(job.before),after:{geometry:{},labels:{}}}),/尺寸/);
  const rejected=assert.rejects(change);controller.abort();await rejected;
  assert.equal(quality.report({id:job.id}).accepted,false);assert.equal(quality.pending(),null);
  quality.timeoutMs=30;
  assert.equal((await store.apply(batch(read,[add(node('n_check01'))]))).error.code,'E_QUALITY_UNAVAILABLE');
  const disabled=store.apply(batch(read,[add(node('n_check01'))]));await pending(quality);quality.setEnabled(false);
  assert.equal((await disabled).error.code,'E_QUALITY_UNAVAILABLE');assert.equal((await store.snapshot()).revision,before.revision);assert.deepEqual(await readFile(join(store.directory,'boards',store.file)),originalBytes);
});

test('disable and re-enable after measurement cannot revive a candidate waiting for the write queue',async t=>{
  const {store,quality}=await fixture(t),read=await store.read();
  const originalBytes=await readFile(join(store.directory,'boards',store.file));
  const change=store.apply(batch(read,[add(node('n_check01'))]));await pending(quality);
  let unlock,entered;
  const held=new Promise(resolve=>{entered=resolve;});
  const lock=store.exclusive(()=>new Promise(resolve=>{unlock=resolve;entered();}));await held;
  await report(quality);quality.setEnabled(false);quality.setEnabled(true);unlock();await lock;
  assert.equal((await change).error.code,'E_QUALITY_UNAVAILABLE');
  assert.deepEqual(await readFile(join(store.directory,'boards',store.file)),originalBytes);assert.equal(store.bundle.file.history.length,0);
  const retry=store.apply(batch(read,[add(node('n_check01'))]));await report(quality);assert.equal((await retry).ok,true);
});

test('disable and re-enable just before persistence cancels the old write generation',async t=>{
  const {store,quality}=await fixture(t),read=await store.read();
  const originalBytes=await readFile(join(store.directory,'boards',store.file)),persist=store.persist.bind(store);
  store.persist=(...args)=>{quality.setEnabled(false);quality.setEnabled(true);return persist(...args);};
  const change=store.apply(batch(read,[add(node('n_check01'))]));
  const rejected=assert.rejects(change,{code:'E_QUALITY_UNAVAILABLE'});await report(quality);await rejected;
  assert.deepEqual(await readFile(join(store.directory,'boards',store.file)),originalBytes);assert.equal(store.bundle.file.history.length,0);
});
