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
  const session={sessionId:'panel-session',prompt:async(content,mode,signal,requestId)=>{
    window.__panelAdmission={content,mode,requestId};
    if(window.__loseAdmissionOnce){window.__loseAdmissionOnce=false;throw new Error('合成丢失响应');}
    return{ok:true};
  }};
  plugin.apply({effect:create=>create(),
    slots:{inject:(_name,create)=>create(),register:(slot,component)=>{components.set(slot.name,component);return()=>components.delete(slot.name);}},
    conversation:{sendSession:async(bound,text,attachments,mode)=>{
      const result=await bound.prompt([{type:'text',text}],mode,new AbortController().signal,crypto.randomUUID());
      return{kind:result.ok?'success':'error'};
    }},sessions:{list:{getSnapshot:()=>({current:'panel-session'})},binding:()=>({session})}});
  createRoot(document.getElementById('overlay')).render(React.createElement(components.get('shell.overlay'),{usePanelInfo:select=>select({activePanelId:null})}));
}};
