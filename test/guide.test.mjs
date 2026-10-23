import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { BoardGuide, DEFAULT_GUIDE, MAX_GUIDE_BYTES } from '../src/guide.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'dsh-board-guide-'));
  t.after(async()=>{assert.equal(dirname(directory),tmpdir());assert.ok(basename(directory).startsWith('dsh-board-guide-'));await rm(directory,{recursive:true,force:true});});
  const guide=new BoardGuide(directory);await guide.ready;
  return {directory,guide};
}
test('first use seeds the readable default; restart and upgrade preserve user text',async t=>{
  const {directory,guide}=await fixture(t);
  assert.equal((await guide.read()).text,DEFAULT_GUIDE);
  assert.equal(await readFile(guide.path,'utf8'),DEFAULT_GUIDE);
  await writeFile(guide.path,'# 我的白板方法\n核心只写结论，解释放备注。','utf8');
  const restarted=new BoardGuide(directory);await restarted.ready;
  assert.equal((await restarted.read()).text,'# 我的白板方法\n核心只写结论，解释放备注。');
});
test('save checks disk revision, retains previous bytes, and does not refresh stable prompt text needlessly',async t=>{
  const {guide}=await fixture(t),initial=await guide.read();
  const changes=[];guide.subscribe(text=>changes.push(text));
  const next=await guide.save({revision:initial.revision,text:'核心短句\r\n细节放备注。'});
  assert.equal(next.text,'核心短句\n细节放备注。');
  assert.equal(await readFile(guide.previousPath,'utf8'),DEFAULT_GUIDE);
  assert.deepEqual(changes,[next.text]);
  await guide.read();await guide.save({revision:next.revision,text:next.text});
  assert.equal(changes.length,1);
  assert.equal(await readFile(guide.previousPath,'utf8'),DEFAULT_GUIDE,'no-op does not destroy recovery copy');
});
test('external changes cause conflicts instead of overwriting the local editor',async t=>{
  const {guide}=await fixture(t),initial=await guide.read();
  await writeFile(guide.path,'本地编辑器的修改','utf8');
  await assert.rejects(guide.save({revision:initial.revision,text:'设置页的修改'}),error=>error.code==='E_GUIDE_CONFLICT');
  assert.equal(await readFile(guide.path,'utf8'),'本地编辑器的修改');
  assert.equal((await guide.read()).text,'本地编辑器的修改');
});
test('invalid or oversized disk text keeps last valid guidance and original file',async t=>{
  const {guide}=await fixture(t);
  await guide.save({revision:(await guide.read()).revision,text:'有效方法'});
  const invalid=Buffer.from([0xff,0xfe,0x00]);await writeFile(guide.path,invalid);
  const bad=await guide.read();assert.ok(bad.error);assert.equal(bad.text,'有效方法');
  const repaired=await guide.save({revision:bad.revision,text:'修复后的方法'});
  assert.equal(repaired.error,null);assert.deepEqual(await readFile(guide.previousPath),invalid);
  const large='x'.repeat(MAX_GUIDE_BYTES+1);await writeFile(guide.path,large);
  const oversized=await guide.read();assert.ok(oversized.error);assert.equal(oversized.text,'修复后的方法');
  await assert.rejects(guide.save({revision:oversized.revision,text:'不要覆盖'}),/文件过大/);
  assert.equal(await readFile(guide.path,'utf8'),large);
});
test('a missing file is not silently recreated by polling; explicit save restores it',async t=>{
  const {guide}=await fixture(t);await unlink(guide.path);
  const absent=await guide.read();assert.equal(absent.revision,'missing');assert.ok(absent.error);
  await assert.rejects(readFile(guide.path),error=>error.code==='ENOENT');
  assert.equal((await guide.save({revision:absent.revision,text:DEFAULT_GUIDE})).error,null);
});
test('empty guide, BOM/CRLF and UTF-8 size limits work without arbitrary path edits',async t=>{
  const {guide}=await fixture(t);
  const normalized=await guide.save({revision:(await guide.read()).revision,text:'\uFEFF标准方法\r\n父子卡'});
  assert.equal(normalized.text,'标准方法\n父子卡');
  const cleared=await guide.save({revision:normalized.revision,text:''});assert.equal(cleared.text,'');
  for(const text of ['\0','中'.repeat(Math.floor(MAX_GUIDE_BYTES/3)+1),'\ud800'])await assert.rejects(guide.save({revision:cleared.revision,text}),error=>error.code==='E_GUIDE_INVALID');
  await assert.rejects(guide.save({revision:cleared.revision,text:'x',path:'another-file'}),error=>error.code==='E_GUIDE_INVALID');
  assert.equal((await guide.read()).text,'');
});
