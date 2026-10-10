import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const BOARD_INSTRUCTIONS = 'You share a persistent editable whiteboard with the user. Proactively maintain it when useful, using draft_board_read before draft_board_apply. Preserve useful cards and group related edits in one undoable batch. New chat sessions keep the current board until the user changes it. Runtime card associations identify what the current reply refers to; they are not card contents or restrictions on your edit scope. Read content through the tool. Never bypass board batch/version rules with shell or file tools.';
const defaults = { enabled: true, associateSelection: true };
function identity(value) { return typeof value === 'string' && /^[\w-]{1,128}$/.test(value); }
export function normalizeAssociation(value) {
  if (!value?.boardId) return { boardId: null, cards: [] };
  if (!identity(value.boardId) || !Array.isArray(value.cards) || value.cards.length > 1000) throw new Error('Invalid board association');
  const cards = new Map();
  for (const card of value.cards) {
    if (!identity(card?.id)) throw new Error('Invalid card identity');
    cards.set(card.id, { id: card.id, title: String(card.title ?? card.id).replace(/[\r\n]/g, ' ').slice(0, 80) });
  }
  return { boardId: value.boardId, cards: [...cards.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

// Kept outside user-message text, keyed by the native admission identity so
// queued replies retain their own selection across navigation and restarts.
export class BoardContext {
  constructor(path) {
    this.path = path; this.tail = Promise.resolve();
    this.state = { options: { ...defaults }, pending: {}, active: {} };
    this.ready = this.initialize();
  }
  async initialize() {
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state.options = { ...defaults, ...this.state.options };
    this.state.pending ??= {}; this.state.active ??= {};
  }
  get options() { return { ...this.state.options }; }
  save() {
    const next = this.tail.catch(() => {}).then(async () => {
      await this.ready; await mkdir(dirname(this.path), { recursive: true });
      const temp = this.path + '.tmp-' + randomUUID();
      try { await writeFile(temp, JSON.stringify(this.state)); await rename(temp, this.path); }
      finally { await unlink(temp).catch(() => {}); }
    });
    this.tail = next; return next;
  }
  async configure(patch) {
    await this.ready;
    if (!patch || Object.keys(patch).some(key => !Object.hasOwn(defaults, key) || typeof patch[key] !== 'boolean')) throw new Error('Invalid DSH-board options');
    const previous = this.state.options;
    this.state.options = { ...previous, ...patch };
    try { await this.save(); } catch (error) { this.state.options = previous; throw error; }
    return this.options;
  }
  async stage(sessionId, requestId, selection) {
    await this.ready;
    if (!identity(sessionId) || !identity(requestId)) throw new Error('Invalid message admission identity');
    if (Object.keys(this.state.pending).length >= 1000) throw new Error('Too many pending whiteboard associations');
    const key = `${sessionId}:${requestId}`;
    if (!(key in this.state.pending)) {
      this.state.pending[key] = normalizeAssociation(selection);
      try { await this.save(); } catch (error) { delete this.state.pending[key]; throw error; }
    }
  }
  async discard(sessionId, requestId) {
    await this.ready; delete this.state.pending[`${sessionId}:${requestId}`]; await this.save();
  }
  claim(sessionId, message) {
    if (message.source?.kind !== 'user') return false;
    const key = `${sessionId}:${message.source.rpcId}`;
    this.state.active[sessionId] = this.state.pending[key] ?? { boardId: null, cards: [] };
    delete this.state.pending[key]; return true;
  }
  render(sessionId, boardId) {
    if (!this.state.options.enabled) return '';
    const association = this.state.active[sessionId];
    const cards = this.state.options.associateSelection && association?.boardId === boardId ? association.cards : [];
    // No time, message ID, revision, full board or live hover/selection state.
    // Equal associations render identically; DSH deduplicates runtime snapshots.
    return 'DSH-board current reply association (object references, not card contents): ' + JSON.stringify({ boardId, cards });
  }
}
