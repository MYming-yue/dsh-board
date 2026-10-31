import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const EDIT_MODES = ['chat_once', 'chat_continuous', 'auto'];
export const BOARD_WRITE_TOOLS = ['draft_board_apply', 'draft_board_layout_apply'];
const identity = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key));
export function readOnlyError(message = '本轮只聊，可以读取和讨论白板；如需修改，请切换为默认放权后发送新消息。') {
  return Object.assign(new Error(message), { code: 'E_BOARD_READ_ONLY' });
}
function policy(value) {
  if (!exact(value, ['version', 'mode']) || value.version !== 1 || !EDIT_MODES.includes(value.mode))
    throw new Error('非法白板编辑权限');
  return { version: 1, mode: value.mode };
}

// Native admission identities bind a permission once. Composer choices never
// retroactively change queued or running messages. Durable grants also survive
// approval/restart; per-turn abort signals revoke candidates before rename.
export class BoardPermissions {
  constructor(path) {
    this.path = path;
    this.state = { version: 1, sessions: {}, messages: {}, active: {} };
    this.controllers = new Map(); this.tail = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !saved.sessions || !saved.messages || !saved.active) throw new Error('白板权限状态无效');
      this.state = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() {
    const bytes = JSON.stringify(this.state);
    const next = this.tail.catch(() => {}).then(async () => {
      await this.ready; await mkdir(dirname(this.path), { recursive: true });
      const temp = this.path + '.tmp-' + randomUUID();
      try { await writeFile(temp, bytes); await rename(temp, this.path); }
      finally { await unlink(temp).catch(() => {}); }
    });
    this.tail = next; return next;
  }
  choice(sessionId) {
    if (!identity(sessionId)) throw new Error('非法会话身份');
    const value = this.state.sessions[sessionId];
    if (value && (!EDIT_MODES.includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0))
      throw new Error('白板权限状态无效，请重新选择');
    return { version: 1, mode: value?.mode ?? 'auto', revision: value?.revision ?? 0 };
  }
  async configure(value) {
    await this.ready;
    if (!exact(value, ['sessionId', 'mode', 'revision']) || !EDIT_MODES.includes(value.mode)) throw new Error('非法白板编辑权限');
    const current = this.choice(value.sessionId);
    if (value.revision !== current.revision) throw Object.assign(new Error('该聊天的权限已变化，请重试选择。'), { code: 'E_PERMISSION_CONFLICT' });
    const previous = this.state.sessions[value.sessionId];
    const next = { mode: value.mode, revision: current.revision + 1 };
    this.state.sessions[value.sessionId] = next;
    try { await this.save(); }
    catch (error) {
      if (this.state.sessions[value.sessionId] === next) {
        if (previous) this.state.sessions[value.sessionId] = previous; else delete this.state.sessions[value.sessionId];
      }
      throw error;
    }
    return this.choice(value.sessionId);
  }
  key(sessionId, requestId) {
    if (!identity(sessionId) || !identity(requestId)) throw new Error('非法消息身份');
    return `${sessionId}:${requestId}`;
  }
  async stage(sessionId, requestId, permission, revision) {
    await this.ready;
    const key = this.key(sessionId, requestId), normalized = policy(permission);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('非法权限版本');
    const existing = this.state.messages[key];
    if (existing) {
      if (existing.permission.mode !== normalized.mode || existing.revision !== revision) throw new Error('同一消息的白板权限不能改写');
      return;
    }
    // Accepted old records can be dropped only when they no longer authorize a
    // live turn. Pending/uncertain admissions are never silently made writable.
    if (Object.keys(this.state.messages).length >= 2000) {
      const active = new Set(Object.entries(this.state.active).flatMap(([id, turn]) => (turn.requestIds ?? []).map(rpcId => `${id}:${rpcId}`)));
      for (const [id, message] of Object.entries(this.state.messages))
        if (message.accepted && !active.has(id)) delete this.state.messages[id];
      if (Object.keys(this.state.messages).length >= 2000) throw new Error('待确认的白板消息过多，请先处理原生队列。');
    }
    this.state.messages[key] = { permission: normalized, revision, accepted: false };
    try { await this.save(); } catch (error) { delete this.state.messages[key]; throw error; }
  }
  accept(sessionId, requestId) {
    if (!identity(sessionId) || !identity(requestId)) return false;
    const entry = this.state.messages[this.key(sessionId, requestId)];
    if (!entry || entry.accepted) return false;
    entry.accepted = true;
    const current = this.choice(sessionId);
    if (entry.permission.mode === 'chat_once' && current.mode === 'chat_once' && current.revision === entry.revision)
      this.state.sessions[sessionId] = { mode: 'auto', revision: current.revision + 1 };
    return true;
  }
  async discard(sessionId, requestId) {
    await this.ready;
    const key = this.key(sessionId, requestId);
    if (this.state.messages[key]?.accepted) return;
    delete this.state.messages[key]; await this.save();
  }
  claim(agent, message, turn) {
    if (message.source?.kind !== 'user') return false;
    const sessionId = agent.id, requestId = message.source.rpcId;
    if (!identity(sessionId) || !identity(requestId)) return false;
    const entry = this.state.messages[this.key(sessionId, requestId)];
    this.accept(sessionId, requestId);
    const previous = this.state.active[sessionId];
    const turnId = Number.isSafeInteger(turn) ? turn : (previous?.turn ?? 0) + 1;
    const sameTurn = previous?.turn === turnId;
    const writable = Boolean(entry?.permission?.version === 1 && entry.permission.mode === 'auto')
      && (!sameTurn || previous.writable === true);
    if (!sameTurn || !writable) this.controllers.get(sessionId)?.abort(readOnlyError('该响应的白板写权限已结束，候选未提交。'));
    if (!sameTurn) this.controllers.delete(sessionId);
    this.state.active[sessionId] = { turn: turnId, writable,
      requestIds: [...new Set([...(sameTurn ? previous.requestIds : []), requestId])] };
    return true;
  }
  canWrite(agent) { return this.state.active[agent?.id]?.writable === true; }
  writer(agent) {
    if (!this.canWrite(agent)) throw readOnlyError();
    let controller = this.controllers.get(agent.id);
    if (!controller) { controller = new AbortController(); this.controllers.set(agent.id, controller); }
    controller.signal.throwIfAborted();
    return controller.signal;
  }
  render(agent) {
    return this.canWrite(agent)
      ? 'Current whiteboard permission: auto. Maintain the board only when useful; a reply may leave it unchanged.'
      : 'Current whiteboard permission: read_only. You may read and discuss the board. Do not edit content or layout, including through nested tools, shell or file writes. If editing is requested, explain that the user must select 默认放权 and send a new message. This applies to this response and all continuations.';
  }
  dispose() {
    for (const controller of this.controllers.values()) controller.abort(readOnlyError('白板权限服务已关闭，候选未提交。'));
    this.controllers.clear();
  }
}
