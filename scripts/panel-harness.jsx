// Minimal native services for the actual packaged BoardPanel and iframe.
import React from 'react';
import * as ReactModule from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDom from 'react-dom';
import { createRoot } from 'react-dom/client';
const components=new Map();
window.__ModuleLoader__={load(descriptor){
  const modules={react:ReactModule,'react/jsx-runtime':JsxRuntime,'react-dom':ReactDom};
  const plugin=descriptor.factory(name=>modules[name]);
  let snapshot={current:'panel-session'};const listeners=new Set();
  const faces=new Map();
  const binding=id=>{if(!faces.has(id))faces.set(id,{sessionId:id,prompt:async(content,mode,signal,requestId)=>{
    window.__panelAdmission={sessionId:id,content,mode,requestId};
    if(window.__rejectAdmissionOnce){window.__rejectAdmissionOnce=false;return{ok:false};}
    if(window.__loseAdmissionOnce){window.__loseAdmissionOnce=false;throw new Error('合成丢失响应');}
    return{ok:true};
  }});return{session:faces.get(id)};};
  const conversation={sendSession:async(bound,text,attachments,mode)=>{
    const result=await bound.prompt([{type:'text',text}],mode,new AbortController().signal,crypto.randomUUID());
    return{kind:result.ok?'success':'error'};
  }};
  plugin.apply({effect:create=>create(),
    slots:{inject:(_name,create)=>create(),register:(slot,component)=>{components.set(slot.name,component);return()=>components.delete(slot.name);}},
    conversation,sessions:{list:{getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},binding}});
  window.__sendPanel=(text,mode='queue')=>conversation.sendSession(binding(snapshot.current).session,text,[],mode);
  window.__switchPanelSession=id=>{snapshot={current:id};for(const listener of listeners)listener();};
  const control=document.createElement('div');document.querySelector('.native-chat').append(control);
  function Fixture(){
    const current=React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>snapshot).current;
    return React.createElement(React.Fragment,null,
      React.createElement(components.get('shell.overlay'),{usePanelInfo:select=>select({activePanelId:null})}),
      ReactDom.createPortal(React.createElement(components.get('conversation.input.right'),{sessionId:current}),control));
  }
  createRoot(document.getElementById('overlay')).render(React.createElement(Fixture));
}};
