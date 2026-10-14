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
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'dsh-board-package-'));
const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
const releases = [], routes = new Map(), tools = new Map(), events = new Map(), sections = new Map();
let browser, server;
try {
  const packed = await promisify(execFile)(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', artifacts], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  const [metadata] = JSON.parse(packed.stdout);
  for (const file of metadata.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.ok(!/^(\.upstream|node_modules|artifacts|\.env)(\/|$)/.test(file.path));
  }
  const paths = new Set(metadata.files.map(file => file.path));
  for (const path of ['src/host.mjs', 'src/guide.mjs', 'docs/board-guide.md', 'lib/model.js', 'lib/client.js', 'lib/board-ui/index.html', 'lib/upstream.json', 'lib/upstream-LICENSE', 'lib/THIRD_PARTY_NOTICES.txt', 'LICENSE', 'docs/spec.md']) assert.ok(paths.has(path), `Package missing ${path}`);
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
    systemPrompt: { section: definition => { sections.set(definition.name,definition);return ()=>sections.delete(definition.name); }, context: () => () => {}, getSectionOrder: () => 10200 },
  }, { dataDir: join(directory, 'data') });
  const harness=await build({stdin:{contents:await readFile(join(root,'scripts/guide-settings-harness.jsx'),'utf8'),resolveDir:join(root,'.upstream/draft-board'),loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',target:'es2022'});
  routes.set('/_test/settings',{methods:['GET'],fetch:async()=>new Response('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DSH-board 设置回归</title></head><body><main id="settings"></main><script src="/_test/harness.js"></script><script src="/_test/client.js"></script></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})});
  routes.set('/_test/harness.js',{methods:['GET'],fetch:async()=>new Response(harness.outputFiles[0].text,{headers:{'Content-Type':'text/javascript'}})});
  routes.set('/_test/client.js',{methods:['GET'],fetch:async()=>new Response(await readFile(join(installed,'lib/client.js')),{headers:{'Content-Type':'text/javascript'}})});
  const panelHarness=await build({stdin:{contents:await readFile(join(root,'scripts/panel-harness.jsx'),'utf8'),resolveDir:join(root,'.upstream/draft-board'),loader:'jsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',target:'es2022'});
  routes.set('/_test/panel-harness.js',{methods:['GET'],fetch:async()=>new Response(panelHarness.outputFiles[0].text,{headers:{'Content-Type':'text/javascript'}})});
  routes.set('/_test/panel',{methods:['GET'],fetch:async()=>new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>html,body{margin:0;height:100%;font-family:system-ui}._centerCol_fixture{height:100vh}.native-chat{padding:24px;background:#fafafa}h3{margin-top:0}</style><main class="_centerCol_fixture"><div class="native-chat"><h3>原生对话</h3><p>请补充这张卡片的解释</p><textarea aria-label="对话输入">未发送的文字仍在这里</textarea></div></main><div id="overlay"></div><script src="/_test/panel-harness.js"></script><script src="/_test/client.js"></script></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}})});
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
  // Native AI tools and the installed iframe share the same reversible appearance model.
  const appearanceCurrent=await tools.get('draft_board_read').execute();
  const finish={id:'n_flowpackage',type:'text',markdown:'由人确认',caption:'合成备注保留',shape:'pill',x:640,y:460,w:200};
  const flowEdge={id:'e_flowpackage',kind:'association',from:node.id,to:finish.id,directed:true,label:'已厘清',routing:'orthogonal',stroke:'solid'};
  assert.equal((await tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:appearanceCurrent.board.id,baseContentVersion:appearanceCurrent.board.contentVersion,actor:'agent',label:'安装包流程外形',ops:[
    {op:'setNodeShape',nodeId:node.id,before:null,after:{shape:'diamond'}},
    {op:'addNode',node:finish,before:null,after:finish},
    {op:'addEdge',edge:flowEdge,before:null,after:flowEdge},
  ]})},{signal:new AbortController().signal})).ok,true);
  await page.locator(`[data-node-id="${node.id}"][data-node-shape="diamond"]`).waitFor();
  await page.locator(`[data-node-id="${finish.id}"][data-node-shape="pill"]`).waitFor();
  await page.waitForFunction(()=>window.__state.saveState==='saved');
  assert.equal((await tools.get('draft_board_read').execute()).edges[0].routing,'orthogonal');
  await page.screenshot({path:join(artifacts,'package-flow-appearance.png')});
  await page.reload({waitUntil:'networkidle'});await page.locator('.toolbar').waitFor();
  await page.locator(`[data-node-id="${node.id}"][data-node-shape="diamond"]`).waitFor();
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForFunction(()=>window.__state.file.nodes.length===1&&!window.__state.file.nodes[0].shape&&window.__state.file.edges.length===0&&window.__state.saveState==='saved');
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
  const stablePrompt=sections.get('dsh-board'),stableTools=tools.get('draft_board_apply'),beforeGuide=await tools.get('draft_board_read').execute();
  const guidePath=join(directory,'data/board-guide.md'),standard=await readFile(join(installed,'docs/board-guide.md'),'utf8');
  await page.goto(origin+'/_test/settings',{waitUntil:'networkidle'});
  const editor=page.getByRole('textbox',{name:'白板使用方法提示词',exact:true});
  await page.waitForFunction(()=>document.getElementById('dsh-board-guide-text')?.value.startsWith('# DSH-board'));
  assert.equal(await editor.inputValue(),sections.get('dsh-board-guide').text);
  await editor.fill('核心只写结论；解释放备注。\n父子卡和集合各司其职。');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.startsWith('已保存'));
  assert.equal(await readFile(guidePath,'utf8'),await editor.inputValue());
  assert.equal(sections.get('dsh-board-guide').text,await editor.inputValue());
  await writeFile(guidePath,'本地编辑器修改：公式独立，说明入备注。','utf8');
  await page.waitForFunction(()=>document.getElementById('dsh-board-guide-text')?.value==='本地编辑器修改：公式独立，说明入备注。');
  assert.equal(sections.get('dsh-board-guide').text,await editor.inputValue());
  await editor.fill('尚未保存的设置页草稿');
  await writeFile(guidePath,'另一份本地修改，不能覆盖。','utf8');
  await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.includes('本地文件有更新'));
  assert.equal(await editor.inputValue(),'尚未保存的设置页草稿');
  assert.equal(await page.getByRole('button',{name:'保存修改',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'重新读取本地文件',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('dsh-board-guide-text')?.value==='另一份本地修改，不能覆盖。');
  await page.getByRole('button',{name:'载入标准方法',exact:true}).click();
  assert.equal(await readFile(guidePath,'utf8'),'另一份本地修改，不能覆盖。','loading standard is an editable preview, not an immediate overwrite');
  await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent.startsWith('已保存'));
  assert.equal((await readFile(guidePath,'utf8')).replace(/\r\n/g,'\n'),standard.replace(/\r\n/g,'\n'));
  assert.equal(await readFile(join(directory,'data/board-guide.previous.md'),'utf8'),'另一份本地修改，不能覆盖。');
  assert.equal(sections.get('dsh-board'),stablePrompt);assert.equal(tools.get('draft_board_apply'),stableTools);
  assert.equal((await tools.get('draft_board_read').execute()).revision,beforeGuide.revision,'guide saves do not change the draft');
  await page.screenshot({path:join(artifacts,'package-guide-settings.png'),fullPage:true});
  await page.goto(origin+'/_test/panel',{waitUntil:'networkidle'});
  const frame=page.frameLocator('iframe.dsh-board-frame');
  await frame.locator('.toolbar').waitFor();
  await frame.getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=pending]').waitFor();
  const admitted=await page.evaluate(()=>window.__panelAdmission);
  assert.equal(admitted.content[0].text,'✦ 整理白板布局','native pending echoes contain a short task label, not raw instructions');
  const panelTask=await page.evaluate(async()=>{const r=await fetch('/api/dsh-board/layout');return(await r.json()).task;});
  const panelAgent={id:'panel-session',ctx:{tools:{restrict:()=>()=>{}}}},panelExec={agent:panelAgent,signal:new AbortController().signal};
  events.get('agent/inbox/claimed')({agent:panelAgent,message:{source:{kind:'user',rpcId:admitted.requestId}}});
  await page.locator('.dsh-layout-float[data-state=running]').waitFor();
  await page.route('**/api/dsh-board/layout?id=*',async route=>{
    if(route.request().method()==='GET' && route.request().frame()===page.mainFrame()) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'合成网络波动'}})});
    else await route.continue();
  });
  await page.getByText('状态暂时无法读取，正在重连。合成网络波动',{exact:true}).waitFor();
  assert.equal(await page.locator('.dsh-layout-float[data-state=failed]').count(),0,'temporary transport failure is not a failed task');
  await page.unroute('**/api/dsh-board/layout?id=*');
  await page.getByText('梳理关系，让空间更有秩序',{exact:true}).waitFor();
  const panelRead=await tools.get('draft_board_layout_read').execute({},panelExec);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dsh-layout-float')).opacity==='1');
  await page.screenshot({path:join(artifacts,'package-layout-running.png')});
  assert.equal((await tools.get('draft_board_layout_apply').execute({taskId:panelTask.id,boardId:panelRead.boardId,baseContentVersion:panelRead.baseContentVersion,positions:[{nodeId:node.id,x:360,y:240}]},panelExec)).ok,true);
  await page.locator('.dsh-layout-float[data-state=completed]').waitFor();
  await page.getByText('已整理 1 张卡片 · 可撤销这一轮',{exact:true}).waitFor();
  await page.locator('.dsh-layout-float').waitFor({state:'hidden',timeout:10000});
  await frame.getByRole('button',{name:'撤销最新一轮',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'对话输入'}).inputValue(),'未发送的文字仍在这里');
  events.get('agent/status')({agent:panelAgent,status:'idle'});
  await frame.getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=pending]').waitFor();
  await page.route('**/api/dsh-board/layout?id=*',async route=>{
    if(route.request().method()==='DELETE') await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'取消断线'}})});
    else await route.continue();
  });
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByText('取消未确认，可重试。取消断线',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'取消',exact:true}).isVisible(),true);
  await page.unroute('**/api/dsh-board/layout?id=*');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=cancelled]').waitFor();
  await frame.getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=pending]').waitFor();
  const failedAdmission=await page.evaluate(()=>window.__panelAdmission);
  events.get('agent/inbox/claimed')({agent:panelAgent,message:{source:{kind:'user',rpcId:failedAdmission.requestId}}});
  events.get('agent/status')({agent:panelAgent,status:'idle'});
  await page.locator('.dsh-layout-float[data-state=failed]').waitFor();
  await page.getByRole('alert').filter({hasText:'这次整理未完成'}).waitFor();
  await page.getByRole('button',{name:'收起布局提示',exact:true}).click();
  assert.equal(await page.locator('.dsh-layout-float').count(),0);
  await page.evaluate(()=>{window.__loseAdmissionOnce=true;});
  await frame.getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=pending]').waitFor();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.dsh-layout-float[data-state=cancelled]').waitFor();
  assert.deepEqual(errors,[]);
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(join(artifacts, metadata.filename + '.sha256'), `${checksum}  ${metadata.filename}\n`);
  console.log(`PACKAGE PASS: extracted ${metadata.filename}; board round undo, editable guide, actual BoardPanel layout progress/completion/cancel/failure and preserved native input; no browser errors.`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const release of releases.toReversed()) release?.();
  const checked = await realpath(directory), boundary = await realpath(tmpdir());
  assert.equal(dirname(checked), boundary); assert.ok(basename(checked).startsWith('dsh-board-package-'));
  await rm(resolve(checked), { recursive: true, force: true });
}
