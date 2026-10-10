import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { associatedSession } from './submission.mjs';
import styles from './client.css';

export const inject = ['slots', 'conversation'];
export function apply(ctx) {
  const style = document.createElement('style'); style.textContent = styles;
  document.head.append(style); ctx.effect(() => () => style.remove());
  const bridge = { frame: null, selection: null, requests: new Map() };
  let options = { enabled: true, associateSelection: true };
  const optionListeners = new Set();
  const publishOptions = next => { options = next; for (const listener of optionListeners) listener(next); };
  async function api(path, body, method = 'POST', signal) {
    const response = await fetch('/api/dsh-board/' + path, { method, signal, cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? 'DSH-board 请求失败');
    return result;
  }
  let disposed = false;
  let timer;
  async function refreshOptions() {
    try { const next = await api('options', null, 'GET'); if (!disposed) publishOptions(next); }
    catch { /* Keep the last known preferences during a temporary disconnect. */ }
    finally { if (!disposed) timer = setTimeout(refreshOptions, 1500); }
  }
  void refreshOptions(); ctx.effect(() => () => { disposed = true; clearTimeout(timer); });
  function useOptions() {
    const [value, setValue] = useState(options);
    useEffect(() => { optionListeners.add(setValue); setValue(options); return () => optionListeners.delete(setValue); }, []);
    return value;
  }
  const service = ctx.conversation;
  const originalSend = service.sendSession;
  if (typeof originalSend !== 'function') throw new Error('DSH-board: unsupported Conversation submission interface');
  function flush() {
    if (!bridge.frame) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { bridge.requests.delete(id); reject(new Error('白板同步未完成，请稍后重试。')); }, 15000);
      bridge.requests.set(id, { resolve, reject, timer });
      bridge.frame.contentWindow.postMessage({ source: 'dsh-board-host', type: 'flush', id }, location.origin);
    });
  }
  async function sendWithReferences(session, text, ...args) {
    if (!options.enabled) return originalSend.call(this, session, text, ...args);
    const selection = bridge.selection;
    await flush();
    const bound = associatedSession(session, options.associateSelection ? selection : null, {
      stage: (sessionId, requestId, selection, signal) => api('association', { sessionId, requestId, selection }, 'POST', signal),
      discard: (sessionId, requestId) => api('association', { sessionId, requestId }, 'DELETE'),
    });
    return originalSend.call(this, bound, text, ...args);
  }
  service.sendSession = sendWithReferences;
  ctx.effect(() => () => {
    service.sendSession = originalSend;
    for (const request of bridge.requests.values()) { clearTimeout(request.timer); request.reject(new Error('DSH-board 已卸载。')); }
    bridge.requests.clear();
  });

  function BoardPanel(props) {
    const preferences = useOptions();
    const activePanel = props.usePanelInfo(info => info.activePanelId);
    const frame = useRef(null);
    const [target, setTarget] = useState(null);
    const [selection, setSelection] = useState(null);
    const [open, setOpen] = useState(true);
    const [width, setWidth] = useState(() => {
      const saved = Number(localStorage.getItem('dsh-board-chat-width'));
      return Number.isFinite(saved) && saved >= 320 ? Math.min(saved, 900) : 420;
    });
    const [resizing, setResizing] = useState(false);
    useEffect(() => {
      if (activePanel !== null) return;
      // Target the installed 0.1.5 AppFrame's centre column. Native nodes stay
      // owned by DSH; only our mount and namespaced layout classes are added.
      const center = document.querySelector('[class*="_centerCol"]');
      if (!center) throw new Error('DSH-board: unsupported AppFrame centre column');
      const mount = document.createElement('div'); mount.className = 'dsh-board-mount';
      center.append(mount); center.classList.add('dsh-board-center');
      const attachment = { center, mount, native: null, decorations: new Set(), collapsed: false };
      const observer = new MutationObserver(attach);
      function attach() {
        observer.disconnect(); observer.observe(center, { childList: true });
        for (const decoration of attachment.decorations) {
          decoration.removeAttribute('data-dsh-board-decoration'); decoration.removeAttribute('data-dsh-board-collapsed');
        }
        attachment.decorations.clear();
        for (const child of center.children) {
          if (child !== mount && ['absolute', 'fixed'].includes(getComputedStyle(child).position)) {
            attachment.decorations.add(child); child.setAttribute('data-dsh-board-decoration', '');
            child.toggleAttribute('data-dsh-board-collapsed', attachment.collapsed);
          }
        }
        const inFlow = parent => [...parent.children].find(child => child !== mount && !['absolute', 'fixed'].includes(getComputedStyle(child).position));
        let native = inFlow(center);
        while (native && getComputedStyle(native).display === 'contents') {
          observer.observe(native, { childList: true }); native = inFlow(native);
        }
        if (attachment.native !== native) {
          attachment.native?.removeAttribute('data-dsh-board-chat');
          attachment.native?.removeAttribute('data-dsh-board-collapsed');
          attachment.native = native;
        }
        native?.setAttribute('data-dsh-board-chat', '');
        native?.toggleAttribute('data-dsh-board-collapsed', attachment.collapsed);
      }
      attach();
      setTarget(attachment);
      return () => {
        observer.disconnect();
        center.classList.remove('dsh-board-center', 'dsh-board-resizing', 'dsh-board-disabled');
        center.style.removeProperty('--dsh-board-chat-width');
        attachment.native?.removeAttribute('data-dsh-board-chat'); attachment.native?.removeAttribute('data-dsh-board-collapsed');
        for (const decoration of attachment.decorations) {
          decoration.removeAttribute('data-dsh-board-decoration'); decoration.removeAttribute('data-dsh-board-collapsed');
        }
        mount.remove(); setTarget(null); bridge.frame = null; bridge.selection = null;
      };
    }, [activePanel]);
    useEffect(() => {
      if (!target) return;
      const measure = () => target.center.style.setProperty('--dsh-board-chat-width', open ? Math.min(width, Math.max(320, target.center.clientWidth * .7)) + 'px' : '0px');
      measure(); target.collapsed = !open; target.native?.toggleAttribute('data-dsh-board-collapsed', !open);
      for (const decoration of target.decorations) decoration.toggleAttribute('data-dsh-board-collapsed', !open);
      const observer = new ResizeObserver(measure); observer.observe(target.center);
      return () => observer.disconnect();
    }, [target, open, width]);
    useEffect(() => { target?.center.classList.toggle('dsh-board-resizing', resizing); }, [target, resizing]);
    useEffect(() => { target?.center.classList.toggle('dsh-board-disabled', !preferences.enabled); }, [target, preferences.enabled]);
    useEffect(() => {
      if (!target) return;
      bridge.frame = frame.current;
      const message = event => {
        if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'dsh-board') return;
        if (event.data.type === 'selection') { bridge.selection = event.data; setSelection(event.data); }
        if (event.data.type === 'flushed') {
          const request = bridge.requests.get(event.data.id); if (!request) return;
          clearTimeout(request.timer); bridge.requests.delete(event.data.id);
          if (event.data.error) request.reject(new Error(event.data.error)); else request.resolve();
        }
      };
      window.addEventListener('message', message);
      return () => { window.removeEventListener('message', message); bridge.frame = null; bridge.selection = null; };
    }, [target]);
    const resize = next => {
      const maximum = Math.max(320, (target?.center.clientWidth ?? 1200) * .7);
      const value = Math.round(Math.max(320, Math.min(maximum, next)));
      setWidth(value); localStorage.setItem('dsh-board-chat-width', String(value));
    };
    if (!target) return null;
    return createPortal(<>
      <header className="dsh-board-strip"><span>共同白板</span>
        <span className="dsh-board-association">{!preferences.associateSelection ? '卡片关联已关闭' : selection?.cards?.length ? '关联：' + selection.cards.map(card => card.title || card.id).join('、') : '未关联卡片'}</span>
        <span className="dsh-board-sync">{selection?.status ?? '连接白板…'}</span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起对话' : '展开对话'}</button>
      </header>
      <iframe ref={frame} className="dsh-board-frame" title="共同草稿白板" src="/api/dsh-board/ui/index.html?dshBoard=1" />
      <div className="dsh-board-divider" role="separator" aria-label="调整对话宽度" aria-orientation="vertical" tabIndex={open ? 0 : -1} hidden={!open}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(target.center.getBoundingClientRect().right - event.clientX); }}
        onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); }}
        onPointerCancel={() => setResizing(false)}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(width + (event.key === 'ArrowLeft' ? 24 : -24)); } }} />
    </>, target.mount);
  }
  function BoardSettings() {
    const preferences = useOptions();
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    async function change(field, value) {
      setSaving(true); setError(null);
      try {
        if (field === 'enabled' && !value) await flush();
        publishOptions(await api('options', { [field]: value }));
      } catch (cause) { setError(cause.message); }
      finally { setSaving(false); }
    }
    return <section className="dsh-board-settings">
      <h2>DSH-board 白板</h2>
      <p>版本 {preferences.version ?? '…'} · 当前草稿：{preferences.draftName ?? '…'}</p>
      <label><input type="checkbox" checked={preferences.enabled} disabled={saving} onChange={e => void change('enabled', e.target.checked)} />启用共同白板</label>
      <p>关闭后恢复完整聊天界面，暂停白板工具；草稿保留，再次启用继续维护。</p>
      <label><input type="checkbox" checked={preferences.associateSelection} disabled={saving || !preferences.enabled} onChange={e => void change('associateSelection', e.target.checked)} />发送时关联选中的卡片</label>
      <p>只关联身份和短标题，不附上正文。信息放入本轮上下文，不显示在你的回复里。</p>
      <p>白板使用说明保持固定，关联快照在上下文末尾按变化更新。</p>
      {error && <p role="alert">{error}</p>}
      {saving && <p role="status">正在保存…</p>}
    </section>;
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-board' }, BoardPanel));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-board', order: 80, label: 'DSH-board 白板' }, BoardSettings));
}
