import { mkdir, open, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_GUIDE_BYTES = 16 * 1024;
export const DEFAULT_GUIDE = normalize(await readFile(new URL('../docs/board-guide.md', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function normalize(text) { return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
export class GuideError extends Error {
  constructor(message, code = 'E_GUIDE_INVALID') { super(message); this.code = code; }
}
function validate(text) {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > MAX_GUIDE_BYTES || text.includes('\0'))
    throw new GuideError('方法说明必须是 UTF-8 文本，不超过 16 KiB，不能包含空字符。');
  return normalize(text);
}

// The fixed local path is the sole user copy; the packaged file is its default.
export class BoardGuide {
  constructor(directory) {
    this.path = join(directory, 'board-guide.md');
    this.previousPath = join(directory, 'board-guide.previous.md');
    this.text = validate(DEFAULT_GUIDE);
    this.revision = null;
    this.error = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ready = this.initialize(directory);
  }
  async initialize(directory) {
    await mkdir(directory, { recursive: true });
    try { await writeFile(this.path, DEFAULT_GUIDE, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') this.error = '无法创建本地方法文件；当前保留标准说明。'; }
    await this.load();
  }
  exclusive(action) {
    const next = this.queue.then(() => this.ready).then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  async disk() {
    let metadata;
    try { metadata = await lstat(this.path); }
    catch (error) {
      if (error.code === 'ENOENT') return { revision: 'missing', error: '本地方法文件已移走或删除；保留最近有效说明，保存可重新创建文件。' };
      throw error;
    }
    if (!metadata.isFile()) return { revision: `invalid:${metadata.mtimeMs}:${metadata.size}`, error: '方法路径不是普通文件；保留最近有效说明。' };
    const file = await open(this.path, 'r');
    let bytes;
    try {
      const buffer = Buffer.alloc(MAX_GUIDE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await file.read(buffer, offset, buffer.length-offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    } finally { await file.close(); }
    const revision = digest(bytes) + (metadata.size > MAX_GUIDE_BYTES ? `:${metadata.size}:${metadata.mtimeMs}` : '');
    try {
      if (metadata.size > MAX_GUIDE_BYTES || bytes.length > MAX_GUIDE_BYTES) throw new GuideError('本地方法文件超过 16 KiB；AI 保留最近有效说明。');
      const text = validate(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return { revision, text, bytes };
    } catch (error) { return { revision, bytes, error: error instanceof GuideError ? error.message : '本地方法文件不是有效 UTF-8；AI 保留最近有效说明。' }; }
  }
  async load() {
    let state;
    try { state = await this.disk(); }
    catch { state = { revision: null, error: '无法读取本地方法文件；AI 保留最近有效说明。' }; }
    const previous = this.text;
    if (!state.error) this.text = state.text;
    this.revision = state.revision;
    this.error = state.error ?? null;
    if (this.text !== previous) for (const listener of this.listeners) listener(this.text);
    return this.snapshot();
  }
  snapshot() {
    return { path: this.path, previousPath: this.previousPath, text: this.text, revision: this.revision,
      error: this.error, defaultText: DEFAULT_GUIDE, maxBytes: MAX_GUIDE_BYTES };
  }
  read() { return this.exclusive(() => this.load()); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async atomic(path, bytes) {
    const temporary = path + '.tmp-' + randomUUID();
    try { await writeFile(temporary, bytes); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  save(request) {
    return this.exclusive(async () => {
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.revision !== 'string' || Object.keys(request).some(key => !['text', 'revision'].includes(key)))
        throw new GuideError('只允许保存方法文本和已读取版本。');
      const text = validate(request.text);
      const current = await this.disk();
      if (typeof request.revision !== 'string' || current.revision !== request.revision)
        throw new GuideError('本地文件已被其他编辑器修改；当前编辑保留，请先重新读取并核对。', 'E_GUIDE_CONFLICT');
      const metadata = await lstat(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (metadata && !metadata.isFile()) throw new GuideError('方法路径不是普通文件，不能覆盖。');
      if (!current.error && current.text === text) return this.load();
      if (metadata?.size > MAX_GUIDE_BYTES) throw new GuideError('文件过大；请先用本地编辑器缩短，设置页不会覆盖原文件。');
      if (current.bytes) await this.atomic(this.previousPath, current.bytes);
      // Recheck after writing the recovery copy; external editors do not share
      // our queue. The final rename is atomic, but not a cross-process lock.
      if ((await this.disk()).revision !== request.revision)
        throw new GuideError('保存期间本地文件发生变化；编辑内容保留，请重新读取。', 'E_GUIDE_CONFLICT');
      await this.atomic(this.path, text);
      return this.load();
    });
  }
}
