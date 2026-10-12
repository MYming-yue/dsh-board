import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'dsh-board-package-'));
const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const releases = [], routes = new Map(), tools = new Map(), events = new Map();
let browser, server;
try {
  const packed = await promisify(execFile)(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', artifacts], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  const [metadata] = JSON.parse(packed.stdout);
  for (const file of metadata.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.ok(!/^(\.upstream|node_modules|artifacts|\.env)(\/|$)/.test(file.path));
  }
  const paths = new Set(metadata.files.map(file => file.path));
  for (const path of ['src/host.mjs', 'lib/model.js', 'lib/client.js', 'lib/board-ui/index.html', 'lib/upstream.json', 'lib/upstream-LICENSE', 'lib/THIRD_PARTY_NOTICES.txt', 'LICENSE', 'docs/spec.md']) assert.ok(paths.has(path), `Package missing ${path}`);
  const archive = join(artifacts, metadata.filename);
  await promisify(execFile)('tar', ['-xzf', archive, '-C', directory]);
  const installed = join(directory, 'package');
  const lock = JSON.parse(await readFile(join(installed, 'lib/upstream.json'), 'utf8'));
  assert.deepEqual(lock, JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8')));
  let module;
  new Script(await readFile(join(installed, 'lib/client.js'), 'utf8')).runInNewContext({ window: { __ModuleLoader__: { load: value => { module = value; } } } });
  assert.equal(module.id, 'dsh-board'); assert.equal(typeof module.factory, 'function');
  const { apply } = await import(pathToFileURL(join(installed, 'src/host.mjs')).href);
  await apply({
    effect: create => { const release = create(); releases.push(release); return release; },
    on: (name,handler) => events.set(name,handler), logger: { warn() {} },
    connection: { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } },
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); }, guard: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {}, getSectionOrder: () => 10200 },
  }, { dataDir: join(directory, 'data') });
  server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`), route = routes.get(url.pathname);
      if (!route || !route.methods.includes(incoming.method)) { outgoing.writeHead(404); outgoing.end(); return; }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(url, { method: incoming.method, headers: incoming.headers,
        ...['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) } });
      const response = await route.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const candidates = process.env.DSH_BOARD_BROWSER ? [process.env.DSH_BOARD_BROWSER] : ['chrome', 'msedge', 'chromium'];
  const failures = [];
  for (const channel of candidates) {
    try { browser = await chromium.launch({ headless: true, ...channel === 'chromium' ? {} : { channel } }); console.log(`Package browser: ${channel} ${browser.version()}`); break; }
    catch (error) { failures.push(`${channel}: ${error.message.split('\n')[0]}`); }
  }
  if (!browser) throw new Error('No test browser. ' + failures.join('; '));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(()=>{
    window.addEventListener('message',async event=>{
      if(event.origin!==location.origin || event.source!==window || event.data?.source!=='dsh-board' || event.data.type!=='layout-request')return;
      window.__layoutSnapshot=event.data.snapshot;
      const response=await fetch('/api/dsh-board/layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...event.data.snapshot,sessionId:'session1',requestId:'request1'})});
      const task=await response.json();window.__layoutTask=task;
      window.postMessage({source:'dsh-board-host',type:'layout-admitted',id:event.data.id,...response.ok?{task}:{error:task.error.message}},location.origin);
    });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/api/dsh-board/ui/index.html?dshBoard=1', { waitUntil: 'networkidle' });
  await page.locator('.toolbar').waitFor();
  const initial = await tools.get('draft_board_read').execute();
  const node = { id: 'n_package001', type: 'text', markdown: '独立安装包验证', x: 180, y: 200, w: 240 };
  const changed = await tools.get('draft_board_apply').execute({ batch: JSON.stringify({ batchVersion: '1.0', boardId: initial.board.id, baseContentVersion: initial.board.contentVersion, actor: 'agent', label: '安装包浏览器验证', ops: [{ op: 'addNode', node, before: null, after: node }] }) }, { signal: new AbortController().signal });
  assert.equal(changed.ok, true);
  await page.locator(`[data-node-id="${node.id}"]`).waitFor();
  await page.waitForFunction(()=>window.__state.saveState==='saved');
  await page.getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.waitForFunction(()=>window.__layoutTask?.id);
  const layoutTask=await page.evaluate(()=>window.__layoutTask),layoutSnapshot=await page.evaluate(()=>window.__layoutSnapshot);
  const measured=await page.locator(`[data-node-id="${node.id}"]`).evaluate(card=>({w:parseFloat(getComputedStyle(card).width),h:parseFloat(getComputedStyle(card).height)}));
  assert.deepEqual(layoutSnapshot.geometry[node.id],measured,'layout uses real rendered dimensions');
  const agent={id:'session1',ctx:{tools:{restrict:()=>()=>{}}}},exec={agent,signal:new AbortController().signal};
  events.get('agent/inbox/claimed')({agent,message:{source:{kind:'user',rpcId:'request1'}}});
  const layoutRead=await tools.get('draft_board_layout_read').execute({},exec);
  assert.equal(layoutRead.taskId,layoutTask.id);
  assert.equal((await tools.get('draft_board_layout_apply').execute({taskId:layoutTask.id,boardId:initial.board.id,baseContentVersion:layoutRead.baseContentVersion,positions:[{nodeId:node.id,x:400,y:300}]},exec)).ok,true);
  await page.waitForFunction(()=>window.__state.file.nodes[0]?.x===400&&window.__state.saveState==='saved');
  await page.getByRole('button',{name:'AI 布局整理',exact:true}).waitFor();
  await page.screenshot({path:join(artifacts,'package-ai-layout.png')});
  await page.getByRole('button',{name:'撤销最新一轮',exact:true}).click();
  await page.waitForFunction(()=>window.__state.file.nodes[0]?.x===180&&window.__state.saveState==='saved');
  assert.equal((await tools.get('draft_board_read').execute()).nodes[0].y,200,'one undo restores the whole layout');
  events.get('agent/status')({agent,status:'idle'});
  await page.reload({waitUntil:'networkidle'});await page.locator('.toolbar').waitFor();
  // A fresh external content batch remains independently undoable after the layout round.
  const current=await tools.get('draft_board_read').execute();
  assert.equal((await tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:current.board.id,baseContentVersion:current.board.contentVersion,actor:'agent',label:'内容更新独立于布局',ops:[{op:'updateNodeCaption',nodeId:node.id,before:null,after:{caption:'合成回归内容'}}]})},{signal:new AbortController().signal})).ok,true);
  await page.waitForFunction(()=>window.__state.file.nodes[0]?.caption==='合成回归内容');
  await page.getByRole('button', { name: '撤销最新一轮', exact: true }).click();
  await page.waitForFunction(() => !window.__state.file.nodes[0]?.caption && window.__state.saveState === 'saved');
  assert.equal((await tools.get('draft_board_read').execute()).nodes.length, 1);
  await page.reload({ waitUntil: 'networkidle' }); await page.locator('.toolbar').waitFor();
  assert.equal(await page.evaluate(() => window.__state.file.board.id), initial.board.id);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'package-smoke.png') });
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(artifacts, metadata.filename + '.sha256'), `${checksum}  ${metadata.filename}\n`);
  console.log(`PACKAGE PASS: extracted ${metadata.filename}; embedded UI, tool batch, round undo, reload, notices and no browser errors.`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const release of releases.toReversed()) release?.();
  const checked = await realpath(directory), boundary = await realpath(tmpdir());
  assert.equal(dirname(checked), boundary); assert.ok(basename(checked).startsWith('dsh-board-package-'));
  await rm(resolve(checked), { recursive: true, force: true });
}
