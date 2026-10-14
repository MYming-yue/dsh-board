// Read-only integration with an installed DSH frontend. Uses synthetic history
// and actual native renderers; never loads user sessions or authentication.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { LAYOUT_REQUEST } from '../src/layout-submission.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const native=process.env.DSH_BOARD_NATIVE_ROOT;
assert.ok(native,'Set DSH_BOARD_NATIVE_ROOT to the installed @deepseek-ai/dsh/node_modules directory');
const frontend=join(native,'@deepseek-ai/dsh-web-frontend/dist');
const html=await readFile(join(frontend,'index.html'),'utf8');
const asset=html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
assert.ok(asset,'Native frontend entry missing');
const boot=await readFile(join(frontend,asset.replace(/^\//,'')),'utf8');
const cut=boot.lastIndexOf('const p7=document.getElementById("root")');
assert.ok(cut>0 && boot.includes('function by(){return{react:'),'Native bootstrap changed; revalidate adapter');
const base=boot.slice(0,cut)+'\nwindow.__nativeBase=by();\n';
const chat=await readFile(join(native,'@deepseek-ai/dsh-client-ui-chat/lib/client.js'),'utf8');
const widget=await build({entryPoints:[join(root,'src/layout-feedback.jsx')],bundle:true,write:false,platform:'browser',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],target:'es2022'});
const css=await readFile(join(root,'src/client.css'),'utf8');
let server,browser;
try{
  server=createServer(async(incoming,outgoing)=>{
    try{
      const path=new URL(incoming.url,'http://fixture').pathname;
      let text,type='text/javascript';
      if(path==='/'){type='text/html';text=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#f4f5f8;color:#242633}#fixture{padding:35px;max-width:680px;margin:auto}.native-bubble{padding:12px;background:#edf2ff;border-radius:20px} [data-chat-flow-key]{margin:12px 0} .preview-status{margin:32px auto;width:fit-content}</style><style>${css}</style><main id="fixture"></main><script type="module" src="/assets/_native-base.js"></script></html>`;}
      else if(path==='/assets/_native-base.js')text=base;
      else if(path==='/_native-chat.js')text=chat;
      else if(path==='/_widget.js')text=`window.__widget=(()=>{const require=id=>window.__nativeBase[id];var module={exports:{}};${widget.outputFiles[0].text};return module.exports;})();`;
      else if(path.startsWith('/assets/')){const checked=resolve(frontend,'.'+path);assert.ok(checked.startsWith(resolve(frontend)+sep));text=await readFile(checked);}
      else{outgoing.writeHead(404);outgoing.end();return;}
      outgoing.writeHead(200,{'Content-Type':type});outgoing.end(text);
    }catch(error){outgoing.writeHead(500);outgoing.end('Fixture unavailable');}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const page=await browser.newPage({viewport:{width:1000,height:760}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__nativeBase);
  await page.evaluate(()=>{
    const native=window.__nativeBase, registrations=[], definitions=[];
    window.__ModuleLoader__={load:d=>{window.__nativeChat=d.factory(id=>native[id]);}};
    window.__nativeRegistrations=registrations;
    window.__nativeDefinitions=definitions;
  });
  await page.addScriptTag({url:'/_native-chat.js'});
  await page.addScriptTag({url:'/_widget.js'});
  await page.evaluate(()=>{
    const registrations=window.__nativeRegistrations, definitions=window.__nativeDefinitions;
    const effects=[];
    const settings={getSnapshot:()=>({value:{transcriptView:'normal'}}),subscribe:()=>()=>{},set:()=>{}};
    const locale={register:()=>()=>{},bind:()=>key=>key};
    const nativeCtx={slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{const e={options,component,inject:options.inject,locale:options.locale,store:options.store,children:options.children};registrations.push(e);return()=>{};}},
      effect:fn=>{const r=fn();effects.push(r);return r;},locale,
      uiConversation:{events:{register:d=>definitions.push(d),registerFallback:d=>definitions.push(d)},views:{register:()=>{}}},
      uiSession:{provide:()=>{}},settingsScope:{bind:()=>settings},sessions:{},
    };
    window.__nativeChat.apply(nativeCtx);
    window.__slots=registrations;
  });
  await page.evaluate(requestText=>{
    const modules=window.__nativeBase, React=modules.react;
    const core=new modules['@deepseek-ai/dsh-client-ui-slots'].SlotCore();
    core.register({name:'root',children:{'conversation.chat.node':{kind:'keyed',scope:'session'}}},()=>null);
    for(const entry of window.__slots.filter(e=>e.options.name==='conversation.chat.node'))core.register(entry.options,entry.component);
    const originals=new Map(core.entriesOfSlot('conversation.chat.node').map(e=>[e.options.key,e.component]));
    const releases=[];
    const listeners=new Set(),enabledListeners=new Set();
    let enabled=true;
    const turn1={turn:1,status:'closed'},turn2={turn:2,status:'closed'};
    const input={key:'layout-input',kind:'user',location:{kind:'turn',turn:turn1},data:{source:{kind:'user',rpcId:'layout-request'},content:[{type:'text',text:requestText}],time:Date.now()}};
    const reply={key:'layout-reply',kind:'assistant-step',location:{kind:'turn',turn:turn1},data:{status:'settled',turn:1,step:1,blocks:[{kind:'text',text:'布局总结：让主题居中，分支保持留白。'}],time:Date.now()}};
    const ordinary={key:'normal-input',kind:'user',location:{kind:'turn',turn:turn2},data:{source:{kind:'user',rpcId:'ordinary'},content:[{type:'text',text:'请补充这张卡片的解释'}],time:Date.now()}};
    const answer={...reply,key:'normal-reply',location:{kind:'turn',turn:turn2},data:{...reply.data,turn:2,blocks:[{kind:'text',text:'这是一条正常对话回复。'}]}};
    const originalNodes=[input,reply,ordinary,answer];
    let snapshot={nodes:new Map(originalNodes.map(n=>[n.key,n]))};
    const source={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
    const ctx={slots:{inject:(_name,fn)=>{releases.push(fn());},entriesOfSlot:name=>core.entriesOfSlot(name),register:(opts,component)=>core.register(opts,component)},
      sessions:{binding:id=>({sessionId:id})},uiConversation:{binding:()=>({target:()=>source})}};
    const useEnabled=()=>React.useSyncExternalStore(fn=>{enabledListeners.add(fn);return()=>enabledListeners.delete(fn);},()=>enabled);
    window.__widget.installLayoutPresentation(ctx,useEnabled);
    const propsFor=(node,sessionId='session1')=>{
      const entry=core.entriesOfSlot('conversation.chat.node').find(e=>e.options.key===node.kind);
      const face=entry.inject?.(sessionId)??{};
      const useLayoutChat=select=>React.useSyncExternalStore(source.subscribe,()=>select(source.getSnapshot()));
      return{entry,props:{node,sessionId,useLayoutChat,useTurnData:()=>undefined,renderMessageImages:()=>null,openFile:()=>{},fileMentions:()=>undefined,t:key=>key,...face}};
    };
    function Node({node,sessionId}){const{entry,props}=propsFor(node,sessionId);return React.createElement('div',{'data-chat-flow-key':node.key},React.createElement(entry.component,props));}
    function Fixture(){const current=React.useSyncExternalStore(source.subscribe,source.getSnapshot);return React.createElement(React.Fragment,null,
      React.createElement('h3',null,'共同白板 · AI 布局'),
      React.createElement('p',null,'原生 DSH 聊天组件联调 · 合成内容'),
      [...current.nodes.values()].map(node=>React.createElement(Node,{key:node.key,node,sessionId:'session1'})),
      React.createElement('div',{className:'preview-status'},React.createElement(window.__widget.LayoutFeedback,{task:{id:'task1',status:'running'},onCancel:()=>{window.__cancelClicked=true;},onDismiss:()=>{}})));
    }
    const root=modules['react-dom/client'].createRoot(document.getElementById('fixture'));root.render(React.createElement(Fixture));
    window.__nativeAssertions={ordinaryUserDelegated:core.entriesOfSlot('conversation.chat.node').find(e=>e.options.key==='user').component!==originals.get('user'),
      errorsUntouched:core.entriesOfSlot('conversation.chat.node').find(e=>e.options.key==='turn-error').component===originals.get('turn-error'),
      retriesUntouched:core.entriesOfSlot('conversation.chat.node').find(e=>e.options.key==='model-retry').component===originals.get('model-retry')};
    window.__setEnabled=value=>{enabled=value;for(const l of enabledListeners)l();};
    window.__setMixed=value=>{snapshot={nodes:new Map([...originalNodes,...value?[{...ordinary,key:'steer',kind:'steering',location:{kind:'turn',turn:turn1}}]:[]].map(n=>[n.key,n]))};for(const l of listeners)l();};
    window.__resetFixture=()=>{for(const r of releases.toReversed())r?.();root.unmount();};
  },LAYOUT_REQUEST);
  await page.getByRole('button',{name:'AI 布局任务 查看过程'}).waitFor();
  assert.equal(await page.getByText(LAYOUT_REQUEST,{exact:true}).count(),0);
  assert.equal(await page.getByText('布局总结：让主题居中，分支保持留白。',{exact:true}).count(),0);
  await page.getByText('这是一条正常对话回复。',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-chat-flow-key="layout-reply"]').isVisible(),false,'no empty task-output gap');
  await page.getByRole('button',{name:'AI 布局任务 查看过程'}).click();
  await page.getByText(LAYOUT_REQUEST,{exact:true}).waitFor();
  await page.getByText('布局总结：让主题居中，分支保持留白。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'AI 布局任务 收起过程'}).click();
  await page.evaluate(()=>window.__setMixed(true));
  await page.getByText('布局总结：让主题居中，分支保持留白。',{exact:true}).waitFor();
  await page.evaluate(()=>window.__setMixed(false));
  await page.waitForFunction(()=>document.querySelector('[data-chat-flow-key="layout-reply"]')?.textContent==='');
  await page.evaluate(()=>window.__setEnabled(false));
  await page.getByText(LAYOUT_REQUEST,{exact:true}).waitFor();
  await page.evaluate(()=>window.__setEnabled(true));
  await page.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__cancelClicked),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.dsh-layout-orbit').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  const checks=await page.evaluate(()=>window.__nativeAssertions);assert.equal(checks.errorsUntouched,true);assert.equal(checks.retriesUntouched,true);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dsh-layout-float')).opacity==='1');
  await mkdir(join(root,'artifacts'),{recursive:true});
  await page.screenshot({path:join(root,'artifacts/native-layout-presentation.png'),fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});
  await page.addStyleTag({content:':root{color-scheme:dark}body{background:#1b1c23;color:#ddd}'});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.dsh-layout-float')).opacity==='1');
  await page.screenshot({path:join(root,'artifacts/native-layout-presentation-dark.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('NATIVE UI PASS: actual DSH SlotCore election and Chat renderers; layout disclosure, ordinary replies, mixed steering, disable, cancel and reduced motion. Synthetic history only.');
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));}
