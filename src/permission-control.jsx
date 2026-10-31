import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const modes = [
  { id:'auto', label:'默认放权', short:'自动', hint:'由 AI 按需维护白板' },
  { id:'chat_once', label:'本轮只聊', short:'本轮', hint:'下一条只读，发送后自动恢复' },
  { id:'chat_continuous', label:'多轮只聊', short:'只聊', hint:'保持只读，直到手动切换' },
];
function ModeIcon({mode}) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mode === 'auto' ? <><path d="m7 1.8 1.3 3.4 3.4 1.3-3.4 1.3L7 11.2 5.7 7.8 2.3 6.5l3.4-1.3Z"/><path d="m12.5 9 .7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z"/></>
      : <><path d="M3.5 2.5h9A1.5 1.5 0 0 1 14 4v6a1.5 1.5 0 0 1-1.5 1.5H7L3 14v-2.5H3.5A1.5 1.5 0 0 1 2 10V4a1.5 1.5 0 0 1 1.5-1.5Z"/>
        {mode === 'chat_once' ? <path d="m7 5 1.5-1v5M7 9h3"/> : <path d="M6 5v4m4-4v4"/>}</>}
  </svg>;
}
export function PermissionControl({ sessionId, client, enabled }) {
  const [view, setView] = useState(() => ({sessionId,value:client.peek(sessionId)}));
  const [saving, setSaving] = useState(null);
  const [failure, setFailure] = useState(null);
  const [openSession, setOpenSession] = useState(null);
  const [position, setPosition] = useState(null);
  const trigger = useRef(null), menu = useRef(null), initialFocus = useRef(null);
  const menuId = useId();
  const value = view.sessionId === sessionId ? view.value : client.peek(sessionId);
  const current = modes.find(mode => mode.id === value?.mode);
  const open = Boolean(enabled && sessionId && openSession === sessionId);
  const busy = saving === sessionId;
  function close(restoreFocus = false) {
    setOpenSession(null); setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    if (!value || busy) return;
    initialFocus.current = Math.max(0,modes.findIndex(mode => mode.id === value.mode));
    setPosition(null); setOpenSession(sessionId);
  }
  useEffect(() => { setOpenSession(null); setPosition(null); }, [sessionId, enabled]);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect(), box = menu.current.getBoundingClientRect();
      // Measure the portal scale too: CSS zoom on the host must not scale our
      // viewport coordinates a second time. Browser zoom uses the same path.
      const scaleX = box.width / (menu.current.offsetWidth || box.width) || 1;
      const scaleY = box.height / (menu.current.offsetHeight || box.height) || 1;
      const originX = box.left - (parseFloat(menu.current.style.left) || 0) * scaleX;
      const originY = box.top - (parseFloat(menu.current.style.top) || 0) * scaleY;
      const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
      const above = anchor.top - box.height - 6 >= 8;
      const top = Math.max(8,Math.min(above ? anchor.top - box.height - 6 : anchor.bottom + 6, window.innerHeight - box.height - 8));
      const next = {left:(left-originX)/scaleX,top:(top-originY)/scaleY};
      setPosition(previous => previous && Math.abs(previous.left-next.left)<.25 && Math.abs(previous.top-next.top)<.25 ? previous : next);
    }
    place();
    const observer = new ResizeObserver(place); observer.observe(trigger.current); observer.observe(menu.current);
    window.addEventListener('resize',place); window.addEventListener('scroll',place,true);
    return () => { observer.disconnect(); window.removeEventListener('resize',place); window.removeEventListener('scroll',place,true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !position || initialFocus.current === null) return;
    menu.current?.querySelectorAll('[role=menuitemradio]')[initialFocus.current]?.focus();
    initialFocus.current = null;
  }, [open,position]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) close(); };
    const blur = () => close(); // Clicking the board iframe leaves this window's focus; pointerdown cannot cross the frame boundary.
    document.addEventListener('pointerdown',outside,true); document.addEventListener('focusin',outside);
    window.addEventListener('blur',blur);
    return () => { document.removeEventListener('pointerdown',outside,true); document.removeEventListener('focusin',outside); window.removeEventListener('blur',blur); };
  }, [open]);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let stopped = false, timer;
    const unsubscribe = client.subscribe((id, next) => { if (!stopped && id === sessionId) setView({sessionId,value:next}); });
    async function refresh() {
      try { await client.get(sessionId); if (!stopped) setFailure(current => current?.sync && current.sessionId === sessionId ? null : current); }
      catch (cause) { if (!stopped) setFailure({sessionId,sync:true,message:'权限状态暂时无法同步：' + cause.message}); }
      finally { if (!stopped) timer = setTimeout(refresh, 1500); }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
  }, [sessionId, client, enabled]);
  if (!enabled || !sessionId) return null;
  async function change(mode) {
    close(true);
    if (mode === value?.mode || busy) return;
    setSaving(sessionId); setFailure(null);
    try { await client.change(sessionId, mode); }
    catch (cause) { setFailure({sessionId,message:cause.message}); }
    finally { setSaving(current => current === sessionId ? null : current); }
  }
  const error = failure?.sessionId === sessionId ? failure.message : null;
  function navigate(event) {
    if (['Enter',' '].includes(event.key)) event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const items = [...menu.current.querySelectorAll('[role=menuitemradio]')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index+1)%items.length
      : event.key === 'ArrowUp' ? (index+items.length-1)%items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : null;
    if (next !== null) { event.preventDefault(); event.stopPropagation(); items[next].focus(); }
  }
  return <div className="dsh-board-permission" data-mode={value?.mode}>
    <button ref={trigger} type="button" className="dsh-board-permission-trigger" data-mode={value?.mode}
      aria-label={'白板编辑权限，当前：' + (current?.label ?? '读取中')} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      aria-busy={busy} aria-disabled={busy || !value} disabled={!value}
      title={error ?? (current ? current.label + ' · ' + current.hint : '正在读取白板权限')}
      onClick={() => { if (!busy) { if (open) close(); else show(); } }}
      onKeyDown={event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); show(); } }}>
      <ModeIcon mode={value?.mode ?? 'auto'}/><span>{current?.short ?? '白板'}</span>
      <svg className="dsh-board-permission-chevron" width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>
    </button>
    {error && <span className="dsh-board-permission-warning" title={error} role="alert">!<span className="dsh-board-permission-sr">{error}</span></span>}
    {open && createPortal(<div ref={menu} id={menuId} className="dsh-board-permission-menu" role="menu" aria-label="白板编辑权限"
      style={position ?? {left:0,top:0,visibility:'hidden'}} onKeyDown={navigate}>
      <div className="dsh-board-permission-heading">白板协作</div>
      {modes.map(mode => <button key={mode.id} type="button" role="menuitemradio" aria-checked={value?.mode === mode.id}
        aria-label={mode.label} aria-describedby={menuId + '-' + mode.id} tabIndex={-1} data-mode={mode.id} onClick={() => void change(mode.id)}>
        <span className="dsh-board-permission-mode-icon"><ModeIcon mode={mode.id}/></span>
        <span className="dsh-board-permission-copy"><span>{mode.label}</span><small id={menuId + '-' + mode.id}>{mode.hint}</small></span>
        <svg className="dsh-board-permission-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg>
      </button>)}
      {error && <p className="dsh-board-permission-menu-error">{error}</p>}
      <div className="dsh-board-permission-footer">仅此聊天 · 只聊仍可读取白板</div>
    </div>,document.body)}
  </div>;
}
