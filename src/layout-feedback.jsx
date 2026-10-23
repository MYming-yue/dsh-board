import React, { useSyncExternalStore } from 'react';
import { isLayoutMessage, layoutTurnRequest } from './layout-presentation.mjs';

export function LayoutGlyph({ active = false }) {
  return <svg className="dsh-layout-glyph" data-active={active || undefined} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <circle className="dsh-layout-orbit" cx="20" cy="20" r="18" />
    <path className="dsh-layout-links" d="M13 16v9h14V16M20 12v13" />
    <rect className="dsh-layout-tile dsh-layout-tile-a" x="15" y="7" width="10" height="8" rx="2" />
    <rect className="dsh-layout-tile dsh-layout-tile-b" x="7" y="23" width="10" height="8" rx="2" />
    <rect className="dsh-layout-tile dsh-layout-tile-c" x="23" y="23" width="10" height="8" rx="2" />
  </svg>;
}
export function LayoutFeedback({ task, onCancel, onDismiss }) {
  if (!task) return null;
  const active = ['submitting', 'pending', 'running'].includes(task.status);
  const titles = { submitting: '唤醒布局灵感', pending: '等待开始编排', running: '正在编排白板', completed: '布局已就绪', cancelled: '已取消整理', failed: '这次整理未完成' };
  const subtitle = task.status === 'completed' ? (task.moved ? `已整理 ${task.moved} 张卡片 · 可撤销这一轮` : '当前布局无需调整') :
    task.message ?? ({submitting: '正在连接当前 AI', pending: '当前对话空闲后开始', running: '梳理关系，让空间更有秩序', cancelled: '未提交的布局已停止'}[task.status]);
  return <div className="dsh-layout-float" data-state={task.status}>
    <div className="dsh-layout-glow" aria-hidden="true" />
    <LayoutGlyph active={active} />
    <div className="dsh-layout-copy" role={task.status === 'failed' ? 'alert' : 'status'} aria-live="polite">
      <strong>{titles[task.status] ?? '布局任务'}<span className="dsh-layout-spark" aria-hidden="true">✦</span></strong>
      <span>{subtitle}</span>
    </div>
    {active ? task.id && <button type="button" onClick={onCancel}>取消</button> :
      <button type="button" aria-label="收起布局提示" onClick={onDismiss}>×</button>}
  </div>;
}

// Shadow documented keyed seats and delegate ordinary content to its original
// renderer. Stored history, admission and tool execution remain native.
export function installLayoutPresentation(ctx, useEnabled) {
  if (!ctx.slots.entriesOfSlot || !ctx.uiConversation) return;
  const disclosed = new Set(), listeners = new Set();
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const toggle = key => { disclosed.has(key) ? disclosed.delete(key) : disclosed.add(key); for (const listener of listeners) listener(); };
  const sources = new Map();
  const sourceFor = sessionId => {
    if (!sources.has(sessionId)) sources.set(sessionId, ctx.uiConversation.binding(ctx.sessions.binding(sessionId)).target('chat'));
    return sources.get(sessionId);
  };
  ctx.slots.inject('conversation.chat.node', () => {
    const releases = [];
    const keys = ['user', 'steering', 'assistant-step', 'context', 'system-prompt', 'turn-process'];
    for (const entry of ctx.slots.entriesOfSlot('conversation.chat.node')) {
      if (!keys.includes(entry.options.key) || entry.children) continue;
      const Native = entry.component;
      function LayoutNode(props) {
        const enabled = useEnabled();
        const requestId = props.useLayoutChat(snapshot => layoutTurnRequest(snapshot, props.node));
        const key = props.sessionId + ':' + (requestId ?? props.node.data?.source?.rpcId ?? props.node.key);
        const open = useSyncExternalStore(subscribe, () => disclosed.has(key));
        const toolbar = ['user', 'steering'].includes(props.node.kind) && isLayoutMessage(props.node.data);
        if (!enabled || (!toolbar && !requestId)) return <Native {...props} />;
        if (toolbar) return <div className="dsh-layout-chat-task">
          <button type="button" className="dsh-layout-chat-summary" aria-expanded={open} onClick={() => { toggle(key); if (!open) props.turnProcess?.setOpen(true); }}>
            <span aria-hidden="true">✦</span><span>AI 布局任务</span><small>{open ? '收起过程' : '查看过程'}</small>
          </button>
          {open && <div className="dsh-layout-chat-detail"><Native {...props} /></div>}
        </div>;
        return open ? <Native {...props} /> : <span data-dsh-layout-hidden="" aria-hidden="true" />;
      }
      const nativeInject = entry.inject;
      releases.push(ctx.slots.register({ name: 'conversation.chat.node', ...entry.options,
        priority: (entry.options.priority ?? 0) - 10, locale: entry.locale, store: entry.store,
        inject: (sessionId, ...args) => {
          const face = typeof nativeInject === 'function' ? nativeInject(sessionId, ...args) : nativeInject ?? {};
          return {...face, hooks: {...face.hooks, layoutChat: sourceFor(sessionId)}};
        },
      }, LayoutNode));
    }
    return () => { for (const release of releases.toReversed()) release(); sources.clear(); disclosed.clear(); listeners.clear(); };
  });
}
