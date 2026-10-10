import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyBatch, createEmptyBoard, parseBoard, serializeBoard } from '../lib/model.js';

export class BoardConflict extends Error {
  constructor(message, code = 'E_SYNC_CONFLICT') { super(message); this.code = code; }
}

// A single current draft for this local prototype. All mutations are serialized;
// browser snapshots also carry a process-generation revision, independent of contentVersion.
export class BoardStore {
  constructor(directory) {
    this.directory = directory;
    this.generation = randomUUID();
    this.revision = 0;
    this.queue = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    await mkdir(join(this.directory, 'boards'), { recursive: true });
    try {
      const pointer = JSON.parse(await readFile(join(this.directory, 'current.json'), 'utf8'));
      if (!/^[a-f0-9-]{36}\.draft$/.test(pointer.file)) throw new Error('Invalid current draft pointer');
      this.file = pointer.file;
      this.fileName = typeof pointer.fileName === 'string' ? pointer.fileName : '共同草稿.draft';
      this.bundle = parseBoard(new Uint8Array(await readFile(join(this.directory, 'boards', this.file))));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.file = randomUUID() + '.draft';
      this.fileName = '共同草稿.draft';
      this.bundle = { file: createEmptyBoard('共同草稿'), blobs: {} };
      await this.persist(this.bundle, this.file, this.fileName);
    }
  }
  get token() { return `${this.generation}:${this.revision}`; }
  async atomic(path, bytes, signal) {
    const temp = path + '.tmp-' + randomUUID();
    try {
      signal?.throwIfAborted();
      await writeFile(temp, bytes);
      signal?.throwIfAborted();
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async persist(bundle, file, fileName, signal) {
    await this.atomic(join(this.directory, 'boards', file), serializeBoard(bundle.file, bundle.blobs), signal);
    await this.atomic(join(this.directory, 'current.json'), JSON.stringify({ file, fileName }), signal);
  }
  exclusive(action) {
    const next = this.queue.then(() => this.ready).then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  async snapshot(knownRevision) {
    await this.ready; await this.queue;
    if (knownRevision === this.token) return { revision: this.token, fileName: this.fileName };
    return { revision: this.token, fileName: this.fileName, data: Buffer.from(serializeBoard(this.bundle.file, this.bundle.blobs)).toString('base64') };
  }
  async read() {
    await this.ready; await this.queue;
    return { revision: this.token, board: this.bundle.file.board, nodes: this.bundle.file.nodes,
      edges: this.bundle.file.edges, collections: this.bundle.file.collections ?? [],
      operations: 'Use existing Draft Board ops. addNode carries node and after=node; updateNodeText carries nodeId and after={markdown:string}; updateNodeCaption carries nodeId and after={caption:string|null}; moveNode carries nodeId and after={x:number,y:number}; setNodeAccent carries nodeId and after={accent:string|null}; addEdge carries edge and after=edge; removeNode/removeEdge carry the corresponding ID and after=null. Use before=null. IDs use n_/e_/g_ plus 6–32 letters, digits, underscores or hyphens. A batch includes batchVersion=1.0, boardId, baseContentVersion, actor=agent, label, ops.' };
  }
  sync(request, signal) {
    return this.exclusive(async () => {
      if (!request || request.revision !== this.token) throw new BoardConflict('共同草稿已更新；本地内容保留，请另存副本后重新打开该副本。');
      if (typeof request.data !== 'string' || request.data.length > 70 * 1024 * 1024) throw new Error('Draft snapshot is missing or too large');
      const next = parseBoard(new Uint8Array(Buffer.from(request.data, 'base64')));
      if (next.file.board.id !== this.bundle.file.board.id && request.replace !== true) throw new BoardConflict('草稿身份已更换，请重新打开。', 'E_BOARD_MISMATCH');
      const file = request.replace === true ? randomUUID() + '.draft' : this.file;
      const fileName = typeof request.fileName === 'string' ? request.fileName.slice(0, 200) : this.fileName;
      await this.persist(next, file, fileName, signal);
      this.bundle = next; this.file = file; this.fileName = fileName; this.revision++;
      return { revision: this.token };
    });
  }
  apply(batch, signal) {
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const outcome = applyBatch(this.bundle.file, batch);
      if (!outcome.result.ok) return outcome.result;
      const next = { ...this.bundle, file: outcome.file };
      await this.persist(next, this.file, this.fileName, signal);
      this.bundle = next; this.revision++;
      return { ...outcome.result, label: batch.label, revision: this.token };
    });
  }
}
