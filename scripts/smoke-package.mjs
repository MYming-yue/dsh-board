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
  const packagedModel=await import(pathToFileURL(join(installed,'lib/model.js')).href);
  const branchNodes=[[450,59,357,128],[6,342,329,129],[396,342,465,129],[923,353,405,108],[1412,342,330,129]].map(([x,y,w,h],i)=>({id:`n_packfan${i}`,type:'text',markdown:`Card ${i}`,x,y,w,h}));
  const branchEdges=branchNodes.slice(1).map((n,i)=>({id:`e_packfan${i}`,kind:'parentChild',from:branchNodes[0].id,to:n.id,directed:true}));
  const branchBoard={...packagedModel.createEmptyBoard('合成四分支'),nodes:branchNodes,edges:branchEdges};
  assert.deepEqual(packagedModel.readabilityConflicts(branchBoard,{}),[],'installed model avoids the former sibling crossing');
  for(const [id,g] of packagedModel.edgeGeometries(branchEdges,branchNodes,{})){
    const edge=branchEdges.find(e=>e.id===id),target=branchNodes.find(n=>n.id===edge.to),v={x:g.arrow.tip.x-g.arrow.base.x,y:g.arrow.tip.y-g.arrow.base.y};
    assert.equal((g.d.match(/ C /g)||[]).length,1,"packaged clear curves do not add terminal patches");
    assert.ok(Math.abs(v.x*(target.y+target.h/2-g.toPt.y)-v.y*(target.x+target.w/2-g.toPt.x))<.001,"packaged arrows face the actual card centre");
    assert.ok(g.points.slice(1).every((p,i)=>p.y>=g.points[i].y-1e-8),'packaged curves have no upward hooks');
    assert.deepEqual(g.arrow.tip,g.toPt,'arrow tip retains the original endpoint');
    assert.ok(Math.abs(Math.hypot(g.arrow.tip.x-g.arrow.base.x,g.arrow.tip.y-g.arrow.base.y)-10)<.001,'packaged arrow length is fixed');
    assert.ok(Math.abs(Math.hypot(g.arrow.left.x-g.arrow.right.x,g.arrow.left.y-g.arrow.right.y)-7)<.001,'packaged arrow width is fixed');
    assert.notEqual(g.strokeD,g.d,'filled arrow trims only an original curve prefix');
  }
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
  const editorAgent={id:'package-editor'};
  await routes.get('/api/dsh-board/association').fetch(new Request('http://localhost/api/dsh-board/association',{method:'POST',body:JSON.stringify({sessionId:editorAgent.id,requestId:'editor-admission',permission:{version:1,mode:'auto'},permissionRevision:0})}));
  events.get('agent/inbox/claimed')({agent:editorAgent,message:{source:{kind:'user',rpcId:'editor-admission'}},turn:1});
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
    // Use full Chromium/new headless for file-handle persistence, as with Chrome/Edge.
    // https://playwright.dev/docs/browsers#chromium-new-headless-mode
    try { browser = await chromium.launch({ headless: true, channel }); console.log(`Package browser: ${channel} ${browser.version()}`); break; }
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
  await page.goto(origin + '/api/dsh-board/ui/index.html?dshBoard=1', { waitUntil: 'domcontentloaded' });
  await page.locator('.toolbar').waitFor();
  assert.equal(await page.locator('.app-version').textContent(), 'v0.2.4-dev.6');
  const boardName=page.getByRole('textbox',{name:'白板名称',exact:true}),oldTitle=await boardName.inputValue();
  await boardName.fill('');assert.equal(await boardName.inputValue(),'');assert.equal(await boardName.getAttribute('placeholder'),oldTitle);
  await boardName.press('Tab');assert.equal(await boardName.inputValue(),oldTitle);
  await boardName.fill('安装包命名测试');await boardName.press('Enter');
  await page.waitForFunction(()=>window.__state.file.board.name==='安装包命名测试' && window.__state.saveState==='saved');
  const titleSnapshot=await (await routes.get('/api/dsh-board/state').fetch(new Request(origin+'/api/dsh-board/state'))).json();
  assert.equal(titleSnapshot.fileName,'安装包命名测试.draft','hosted filename metadata follows the title');
  await page.evaluate(()=>{window.showSaveFilePicker=async options=>{window.__titleSuggestion=options.suggestedName;throw new DOMException('cancelled','AbortError');};});
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.__titleSuggestion==='安装包命名测试.draft');
  await page.evaluate(async()=>{
    const root=await navigator.storage.getDirectory(),folder='package-binding-'+crypto.randomUUID();
    const directory=await root.getDirectoryHandle(folder,{create:true});
    sessionStorage.setItem('package-binding-folder',folder);sessionStorage.setItem('package-binding-pickers','0');
    window.showSaveFilePicker=async()=>directory.getFileHandle('安装包命名测试.draft',{create:true});
    window.showDirectoryPicker=async()=>{sessionStorage.setItem('package-binding-pickers',String(+sessionStorage.getItem('package-binding-pickers')+1));return directory;};
  });
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>window.__state.fileHandle?.name==='安装包命名测试.draft' && window.__state.saveState==='saved');
  await boardName.fill('包内持久绑定');await boardName.press('Enter');await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>window.__state.fileHandle?.name==='包内持久绑定.draft' && window.__state.saveState==='saved');
  for(let i=0;(await tools.get('draft_board_read').execute()).board.name!=='包内持久绑定';i++){if(i>100)throw new Error('Packaged name did not sync');await new Promise(r=>setTimeout(r,50));}
  await page.addInitScript(()=>{window.showSaveFilePicker=async()=>{throw new Error('Unexpected repeated file picker');};window.showDirectoryPicker=async()=>{throw new Error('Unexpected repeated directory picker');};});
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'白板名称',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'白板名称',exact:true}).fill('包内刷新后改名');await page.getByRole('textbox',{name:'白板名称',exact:true}).press('Enter');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>window.__state.fileHandle?.name==='包内刷新后改名.draft' && window.__state.saveState==='saved');
  assert.equal(await page.evaluate(()=>+sessionStorage.getItem('package-binding-pickers')),1,'packaged refresh reuses the saved folder');
  await page.evaluate(()=>{delete window.showSaveFilePicker;});
  const [bindingDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'另存为',exact:true}).click()]);
  assert.equal(bindingDownload.suggestedFilename(),'包内刷新后改名.draft');
  await page.waitForFunction(()=>window.__state.fileHandle===null && window.__state.saveState==='saved');
  await page.evaluate(async()=>{const folder=sessionStorage.getItem('package-binding-folder');if(!/^package-binding-[\da-f-]+$/.test(folder))throw new Error('Unsafe cleanup');await(await navigator.storage.getDirectory()).removeEntry(folder,{recursive:true});});
  for(let i=0;(await tools.get('draft_board_read').execute()).board.name!=='包内刷新后改名';i++){if(i>100)throw new Error('Packaged restored name did not sync');await new Promise(r=>setTimeout(r,50));}
  const initial = await tools.get('draft_board_read').execute();
  const node = { id: 'n_package001', type: 'text', markdown: '独立安装包验证', x: 180, y: 200, w: 240 };
  const changed = await tools.get('draft_board_apply').execute({ batch: JSON.stringify({ batchVersion: '1.0', boardId: initial.board.id, baseContentVersion: initial.board.contentVersion, actor: 'agent', label: '安装包浏览器验证', ops: [{ op: 'addNode', node, before: null, after: node }] }) }, { agent:editorAgent,signal: new AbortController().signal });
  assert.equal(changed.ok, true);
  await page.locator(`[data-node-id="${node.id}"]`).waitFor();
  await page.waitForFunction(()=>window.__state.saveState==='saved');
  // Ordinary edits render isolated candidates before publishing any history or visible cards.
  const qualityBefore=await tools.get('draft_board_read').execute();
  assert.equal(qualityBefore.layout.status,'measured');
  const qualitySnapshot=await (await routes.get('/api/dsh-board/state').fetch(new Request(origin+'/api/dsh-board/state'))).json();
  const qualityPointer=JSON.parse(await readFile(join(directory,'data/current.json'),'utf8'));
  const qualityDiskPath=join(directory,'data/boards',qualityPointer.file),qualityDiskBytes=await readFile(qualityDiskPath);
  const submitQuality=ops=>tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:qualityBefore.board.id,baseContentVersion:qualityBefore.board.contentVersion,actor:'agent',label:'普通编辑布局预检',ops})},{agent:editorAgent,signal:new AbortController().signal});
  const addQuality=n=>({op:'addNode',node:n,before:null,after:n});
  const overlapping={id:'n_quality001',type:'text',markdown:'重叠候选',x:node.x+20,y:node.y,w:100};
  const refusedPromise=submitQuality([addQuality(overlapping)]);
  const qualityRoute=routes.get('/api/dsh-board/quality');let renderJob;
  for(let i=0;i<100 && !renderJob;i++){renderJob=(await (await qualityRoute.fetch(new Request(origin+'/api/dsh-board/quality'))).json()).job;if(!renderJob)await new Promise(r=>setTimeout(r,10));}
  assert.ok(renderJob,'AI edits require a real render job');
  assert.equal(await page.locator(`[data-node-id="${overlapping.id}"]`).count(),0,'candidate never enters the user canvas');
  const refused=await refusedPromise;
  assert.equal(refused.error.code,'E_EDIT_GEOMETRY');assert.ok(refused.conflicts.some(c=>c.kind==='card'));
  assert.equal((await tools.get('draft_board_read').execute()).revision,qualityBefore.revision);
  const qualityAfter=await tools.get('draft_board_read').execute();
  for(const field of ['board','nodes','edges','collections','revision'])assert.deepEqual(qualityAfter[field],qualityBefore[field]);
  assert.deepEqual(await readFile(qualityDiskPath),qualityDiskBytes,'rejection preserves exact disk bytes and history, independently of ZIP response timestamps');
  assert.equal((await (await routes.get('/api/dsh-board/state').fetch(new Request(origin+'/api/dsh-board/state'))).json()).revision,qualitySnapshot.revision);
  const longCaption=await submitQuality([{op:'updateNodeCaption',nodeId:node.id,before:null,after:{caption:'长备注必须按全文占地检查。\n'.repeat(35)}},addQuality({...overlapping,x:node.x,y:node.y+450})]);
  assert.equal(longCaption.error.code,'E_EDIT_GEOMETRY');assert.ok(longCaption.geometry[node.id].h>450,'selected/full caption measured rather than saved h or clamped notes');
  const measuredWidth=qualityBefore.layout.geometry[node.id].w;
  const neighbor={...overlapping,x:node.x+measuredWidth+30,y:node.y};
  const groups=[{id:'g_quality001',name:'甲区',shape:'rectangle',nodeIds:[node.id],x:0,y:0},{id:'g_quality002',name:'乙区',shape:'rectangle',nodeIds:[neighbor.id],x:0,y:0}];
  const groupOps=groups.map(c=>({op:'addCollection',collection:c,before:null,after:c}));
  const groupRefused=await submitQuality([addQuality(neighbor),...groupOps]);
  assert.equal(groupRefused.error.code,'E_EDIT_GEOMETRY');assert.ok(groupRefused.conflicts.some(c=>c.kind==='collection-overlap'));
  const crossNodes=[[1400,0],[2200,600],[2200,0],[1400,600]].map(([x,y],i)=>({id:`n_crosspkg0${i}`,type:'text',markdown:`节点${i}`,x,y,w:100}));
  const crossEdges=[[0,1],[2,3]].map(([a,b],i)=>({id:`e_crosspkg0${i}`,kind:'association',from:crossNodes[a].id,to:crossNodes[b].id,directed:true,label:'交叉关系'}));
  const crossRefused=await submitQuality([...crossNodes.map(addQuality),...crossEdges.map(e=>({op:'addEdge',edge:e,before:null,after:e}))]);
  assert.equal(crossRefused.error.code,'E_EDIT_GEOMETRY');assert.ok(crossRefused.conflicts.some(c=>c.kind==='edge-crossing'));
  const repaired=await submitQuality([addQuality({...neighbor,x:node.x+measuredWidth+220}),...groupOps,
    addQuality({id:'n_qualitymath',type:'text',markdown:'$$\\frac{a}{b}=c$$',caption:'公式与备注使用真实 KaTeX 外框。',shape:'pill',x:1400,y:1000,w:100})]);
  assert.equal(repaired.ok,true);assert.equal(repaired.layout.status,'checked');
  await page.waitForFunction(()=>window.__state.file.nodes.length===3&&window.__state.saveState==='saved');
  await page.screenshot({path:join(artifacts,'package-quality-checked.png')});
  await page.getByRole('button',{name:'撤销最新一轮',exact:true}).click();
  await page.waitForFunction(()=>window.__state.file.nodes.length===1&&window.__state.file.collections.length===0&&window.__state.saveState==='saved');
  console.log('QUALITY PASS: isolated full-caption/shape/formula measurement; card, collection and crossing-edge refusal; exact no-write failure; corrected single-batch undo.');
  // Native AI tools and the installed iframe share the same reversible appearance model.
  const appearanceCurrent=await tools.get('draft_board_read').execute();
  const finish={id:'n_flowpackage',type:'text',markdown:'由人确认',caption:'合成备注保留',shape:'pill',x:640,y:460,w:200};
  const flowEdge={id:'e_flowpackage',kind:'association',from:node.id,to:finish.id,directed:true,label:'已厘清',routing:'orthogonal',stroke:'flowing-dashed'};
  assert.equal((await tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:appearanceCurrent.board.id,baseContentVersion:appearanceCurrent.board.contentVersion,actor:'agent',label:'安装包流程外形',ops:[
    {op:'setNodeShape',nodeId:node.id,before:null,after:{shape:'diamond'}},
    {op:'addNode',node:finish,before:null,after:finish},
    {op:'addEdge',edge:flowEdge,before:null,after:flowEdge},
  ]})},{agent:editorAgent,signal:new AbortController().signal})).ok,true);
  await page.locator(`[data-node-id="${node.id}"][data-node-shape="diamond"]`).waitFor();
  await page.locator(`[data-node-id="${finish.id}"][data-node-shape="pill"]`).waitFor();
  await page.waitForFunction(()=>window.__state.saveState==='saved');
  assert.equal((await tools.get('draft_board_read').execute()).edges[0].routing,'orthogonal');
  assert.equal((await tools.get('draft_board_read').execute()).edges[0].stroke,'flowing-dashed');
  const flowingPath=page.locator(`[data-edge-id="${flowEdge.id}"] .edge-path`);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>document.querySelector('.edge-flow-active')?.getAnimations().length===1);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('.edge-flow-active')?.getAnimations().length===0);
  assert.equal(await flowingPath.evaluate(el=>getComputedStyle(el).strokeDasharray),'6px, 4px');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.screenshot({path:join(artifacts,'package-flow-appearance.png')});
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.toolbar').waitFor();
  await page.locator(`[data-node-id="${node.id}"][data-node-shape="diamond"]`).waitFor();
  await page.waitForFunction(()=>document.querySelector('.edge-flow-active')?.getAnimations().length===1);
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
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('.toolbar').waitFor();
  // A fresh external content batch remains independently undoable after the layout round.
  const current=await tools.get('draft_board_read').execute();
  assert.equal((await tools.get('draft_board_apply').execute({batch:JSON.stringify({batchVersion:'1.0',boardId:current.board.id,baseContentVersion:current.board.contentVersion,actor:'agent',label:'内容更新独立于布局',ops:[{op:'updateNodeCaption',nodeId:node.id,before:null,after:{caption:'合成回归内容'}}]})},{agent:editorAgent,signal:new AbortController().signal})).ok,true);
  await page.waitForFunction(()=>window.__state.file.nodes[0]?.caption==='合成回归内容');
  await page.getByRole('button', { name: '撤销最新一轮', exact: true }).click();
  await page.waitForFunction(() => !window.__state.file.nodes[0]?.caption && window.__state.saveState === 'saved');
  assert.equal((await tools.get('draft_board_read').execute()).nodes.length, 1);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.toolbar').waitFor();
  assert.equal(await page.evaluate(() => window.__state.file.board.id), initial.board.id);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, 'package-smoke.png') });
  const stablePrompt=sections.get('dsh-board'),stableTools=tools.get('draft_board_apply'),beforeGuide=await tools.get('draft_board_read').execute();
  const guidePath=join(directory,'data/board-guide.md'),standard=await readFile(join(installed,'docs/board-guide.md'),'utf8');
  await page.goto(origin+'/_test/settings',{waitUntil:'domcontentloaded'});
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
  await page.goto(origin+'/_test/panel',{waitUntil:'domcontentloaded'});
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
  // Exercise the actual packaged composer control and admission wrapper.
  const permissionSelect=page.getByRole('button',{name:/^白板编辑权限，当前：/});
  const permissionMenu=page.getByRole('menu',{name:'白板编辑权限',exact:true});
  const permissionLabels={auto:'默认放权',chat_once:'本轮只聊',chat_continuous:'多轮只聊'};
  await permissionSelect.waitFor();
  const compactBounds=await permissionSelect.boundingBox();
  assert.ok(compactBounds.width<=60 && compactBounds.height===24,'compact desktop trigger has a small predictable footprint');
  const selectPermission=async mode=>{
    await permissionSelect.click();
    await permissionMenu.getByRole('menuitemradio',{name:permissionLabels[mode],exact:true}).click();
    await page.waitForFunction(mode=>{const control=document.querySelector('.dsh-board-permission-trigger');return control?.dataset.mode===mode&&control.getAttribute('aria-busy')!=='true';},mode);
    assert.equal(await permissionMenu.count(),0,'choosing a mode closes the menu');
  };
  await permissionSelect.press('ArrowDown');
  const autoOption=permissionMenu.getByRole('menuitemradio',{name:'默认放权',exact:true});
  assert.equal(await autoOption.getAttribute('aria-checked'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'默认放权');
  await autoOption.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'本轮只聊');
  await permissionMenu.getByRole('menuitemradio',{name:'本轮只聊',exact:true}).press('Escape');
  assert.equal(await permissionMenu.count(),0);assert.equal(await permissionSelect.evaluate(el=>el===document.activeElement),true,'Escape restores trigger focus');
  await permissionSelect.click();await page.getByRole('textbox',{name:'对话输入'}).click();
  assert.equal(await permissionMenu.count(),0,'clicking outside dismisses without choosing');
  await permissionSelect.click();await page.frameLocator('iframe.dsh-board-frame').locator('.app-version').click();
  await permissionMenu.waitFor({state:'hidden'});
  assert.equal(await permissionMenu.count(),0,'clicking inside the board iframe also dismisses the host menu');
  await selectPermission('chat_once');
  await page.evaluate(()=>{window.__rejectAdmissionOnce=true;});
  assert.equal((await page.evaluate(()=>window.__sendPanel('只讨论，不修改。'))).kind,'error');
  assert.equal(await permissionSelect.getAttribute('data-mode'),'chat_once','refusal does not consume the one-shot choice');
  assert.equal((await page.evaluate(()=>window.__sendPanel('只讨论，不修改。'))).kind,'success');
  await page.waitForFunction(()=>document.querySelector('.dsh-board-permission-trigger')?.dataset.mode==='auto');
  const readonlyAdmission=await page.evaluate(()=>window.__panelAdmission);
  assert.equal(readonlyAdmission.content[0].text,'只讨论，不修改。');
  events.get('agent/inbox/claimed')({agent:panelAgent,message:{source:{kind:'user',rpcId:readonlyAdmission.requestId}},turn:101});
  const permissionBefore=await tools.get('draft_board_read').execute(),permissionBytes=await readFile(qualityDiskPath);
  const permissionBatch=()=>({batch:JSON.stringify({batchVersion:'1.0',boardId:permissionBefore.board.id,baseContentVersion:permissionBefore.board.contentVersion,actor:'agent',label:'只聊权限回归',ops:[{op:'updateNodeCaption',nodeId:node.id,before:null,after:{caption:'通过授权后才写入。'}}]})});
  assert.equal((await tools.get('draft_board_apply').execute(permissionBatch(),panelExec)).error.code,'E_BOARD_READ_ONLY');
  assert.deepEqual(await readFile(qualityDiskPath),permissionBytes);
  await selectPermission('chat_continuous');
  for(const turn of [102,103]){
    assert.equal((await page.evaluate(()=>window.__sendPanel('继续讨论。'))).kind,'success');
    const admission=await page.evaluate(()=>window.__panelAdmission);
    events.get('agent/inbox/claimed')({agent:panelAgent,message:{source:{kind:'user',rpcId:admission.requestId}},turn});
    assert.equal((await tools.get('draft_board_apply').execute(permissionBatch(),panelExec)).error.code,'E_BOARD_READ_ONLY');
    assert.equal(await permissionSelect.getAttribute('data-mode'),'chat_continuous');
  }
  await permissionSelect.click();
  await page.evaluate(()=>window.__switchPanelSession('another-panel-chat'));
  await page.waitForFunction(()=>document.querySelector('.dsh-board-permission-trigger')?.dataset.mode==='auto');
  assert.equal(await permissionMenu.count(),0,'switching chat closes the previous chat menu');
  await page.evaluate(()=>window.__switchPanelSession('panel-session'));
  await page.waitForFunction(()=>document.querySelector('.dsh-board-permission-trigger')?.dataset.mode==='chat_continuous');
  await page.reload({waitUntil:'domcontentloaded'});await page.frameLocator('iframe.dsh-board-frame').locator('.toolbar').waitFor();
  await page.waitForFunction(()=>document.querySelector('.dsh-board-permission-trigger')?.dataset.mode==='chat_continuous');
  await page.frameLocator('iframe.dsh-board-frame').getByRole('button',{name:'AI 布局整理',exact:true}).click();
  await page.getByText('当前聊天处于只聊状态，请先切换为默认放权，再整理布局。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'收起布局提示',exact:true}).click();
  await permissionSelect.click();
  await permissionMenu.screenshot({path:join(artifacts,'package-permission-menu.png')});
  assert.equal(await permissionMenu.evaluate(el=>el.parentElement===document.body),true,'menu escapes native composer clipping through a portal');
  await permissionMenu.getByRole('menuitemradio',{name:'多轮只聊',exact:true}).press('Escape');
  await page.evaluate(()=>{document.body.style.zoom='.8';});
  assert.equal(await permissionSelect.isVisible(),true);await selectPermission('chat_once');
  await permissionSelect.click();
  const zoomMenu=await permissionMenu.boundingBox();
  assert.ok(zoomMenu.x>=0 && zoomMenu.y>=0 && zoomMenu.x+zoomMenu.width<=1440 && zoomMenu.y+zoomMenu.height<=900,'zoomed menu stays in the viewport');
  const zoomAnchor=await permissionSelect.boundingBox();
  assert.ok(Math.abs(zoomMenu.x+zoomMenu.width-(zoomAnchor.x+zoomAnchor.width))<2,'portal aligns to trigger under CSS zoom');
  await permissionMenu.screenshot({path:join(artifacts,'package-permission-menu-zoom.png')});
  await permissionMenu.getByRole('menuitemradio',{name:'本轮只聊',exact:true}).press('Escape');
  await page.evaluate(()=>{document.body.style.zoom='';});
  await page.emulateMedia({colorScheme:'dark'});
  const darkPreview=await page.addStyleTag({content:':root{color-scheme:dark}'});
  await permissionSelect.click();await permissionMenu.screenshot({path:join(artifacts,'package-permission-menu-dark.png')});
  await permissionMenu.getByRole('menuitemradio',{name:'本轮只聊',exact:true}).press('Escape');
  await darkPreview.evaluate(el=>el.remove());await page.emulateMedia({colorScheme:'light'});
  await page.setViewportSize({width:740,height:580});await permissionSelect.click();
  const narrowMenu=await permissionMenu.boundingBox();
  assert.ok(narrowMenu.x>=0 && narrowMenu.y>=0 && narrowMenu.x+narrowMenu.width<=740 && narrowMenu.y+narrowMenu.height<=580,'narrow composer menu stays visible');
  await permissionMenu.getByRole('menuitemradio',{name:'本轮只聊',exact:true}).press('Escape');
  await page.setViewportSize({width:1440,height:900});
  await selectPermission('auto');
  assert.equal((await page.evaluate(()=>window.__sendPanel('请补充白板。'))).kind,'success');
  const writableAdmission=await page.evaluate(()=>window.__panelAdmission);
  events.get('agent/inbox/claimed')({agent:panelAgent,message:{source:{kind:'user',rpcId:writableAdmission.requestId}},turn:104});
  assert.equal((await tools.get('draft_board_apply').execute(permissionBatch(),panelExec)).ok,true);
  await page.frameLocator('iframe.dsh-board-frame').locator(`[data-node-id="${node.id}"] .node-caption`).waitFor();
  await page.frameLocator('iframe.dsh-board-frame').getByRole('button',{name:'撤销最新一轮',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.__state.saveState==='saved');
  console.log('PERMISSIONS PASS: packaged three-state composer; refusal/acceptance and once reset; exact-message read-only enforcement; continuous mode, session isolation, reload, layout refusal, zoom, authorized edit and undo.');
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
