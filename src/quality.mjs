import { randomUUID } from 'node:crypto';
import { serializeBoard, readabilityConflicts, visibleEdges, collectionBounds } from '../lib/model.js';

const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const finite = n => Number.isFinite(n) && Math.abs(n) <= 1e7;
const error = message => Object.assign(new Error(message), { code: 'E_QUALITY_UNAVAILABLE' });
const encode = (file, blobs) => Buffer.from(serializeBoard(file, blobs)).toString('base64');
function validateMeasurement(file, value) {
  const ids = file.nodes.map(n => n.id);
  if (!keys(value, ['geometry', 'labels']) || !keys(value.geometry, ids) || Object.keys(value.geometry).length !== ids.length ||
      ids.some(id => !Object.hasOwn(value.geometry,id) || !keys(value.geometry[id],['w','h']) || !finite(value.geometry[id].w) || value.geometry[id].w <= 0 || !finite(value.geometry[id].h) || value.geometry[id].h <= 0))
    throw new Error('卡片实际尺寸缺失或无效。');
  const edges = visibleEdges(file.edges).filter(e => e.label).map(e => e.id);
  if (!keys(value.labels,edges) || Object.keys(value.labels).length !== edges.length || edges.some(id =>
    !Object.hasOwn(value.labels,id) || !keys(value.labels[id],['x','y','w','h']) || !['x','y','w','h'].every(k => finite(value.labels[id][k])) || value.labels[id].w < 0 || value.labels[id].h <= 0))
    throw new Error('关系说明的实际尺寸缺失或无效。');
  return structuredClone(value);
}

/** Ephemeral render jobs. Only the packaged read-only browser page supplies measurements. */
export class QualityReview {
  constructor({ timeoutMs = 20000 } = {}) { this.jobs = new Map(); this.timeoutMs = timeoutMs; this.enabled = true; this.controller = new AbortController(); }
  get signal() { return this.controller.signal; }
  setEnabled(enabled) {
    if (enabled && !this.enabled) this.controller = new AbortController();
    this.enabled = enabled;
    if (!enabled) {
      this.controller.abort(error('白板已停用，候选未写入。'));
      for (const job of [...this.jobs.values()]) job.reject(error('白板已停用，候选未写入。'));
    }
  }
  pending() {
    const job = this.jobs.values().next().value;
    return job ? { id:job.id,before:job.before,data:job.data } : null;
  }
  report(value) {
    if (!keys(value,['id','before','after']) || typeof value.id !== 'string') throw new Error('非法检查响应。');
    const job = this.jobs.get(value.id);
    if (!job) return { accepted:false };
    const result = {before:validateMeasurement(job.beforeFile,value.before),after:validateMeasurement(job.afterFile,value.after)};
    job.resolve(result);
    return {accepted:true};
  }
  inspect(before, after, blobs, signal) {
    signal?.throwIfAborted();
    if (!this.enabled) return Promise.reject(error('白板已停用，候选未写入。'));
    if (this.jobs.size >= 8) return Promise.reject(error('布局检查繁忙，请稍后重新读取白板再试。'));
    if (!before.nodes.length && !after.nodes.length && !before.edges.length && !after.edges.length)
      return Promise.resolve({before:{geometry:{},labels:{}},after:{geometry:{},labels:{}}});
    return new Promise((resolve,reject) => {
      const id=randomUUID();
      let timer;
      const finish=(fn,result)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.jobs.delete(id);fn(result);};
      const abort=()=>finish(reject,signal.reason ?? error('检查已取消，候选未写入。'));
      const job={id,before:encode(before,blobs),data:encode(after,blobs),beforeFile:before,afterFile:after,
        resolve:value=>finish(resolve,value),reject:cause=>finish(reject,cause)};
      this.jobs.set(id,job);
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>job.reject(error('未获得真实渲染尺寸，候选未写入。请打开／重新载入共同白板后重试。')),this.timeoutMs);
    });
  }
}

const signature = c => JSON.stringify([c.kind,...[c.nodeId,...c.otherIds].sort(),...(c.edgeIds ?? []).toSorted(),...(c.collectionIds ?? []).toSorted()]);
export function assessReadability(before, after, measured) {
  const touched = new Set();
  for (const section of ['nodes','edges','collections']) {
    const old = new Map((before[section] ?? []).map(item=>[item.id,item]));
    const next = new Map((after[section] ?? []).map(item=>[item.id,item]));
    for (const id of new Set([...old.keys(),...next.keys()])) if (JSON.stringify(old.get(id)) !== JSON.stringify(next.get(id))) touched.add(id);
  }
  const existing = new Set(readabilityConflicts(before,measured.before.geometry,measured.before.labels).map(signature));
  const all = readabilityConflicts(after,measured.after.geometry,measured.after.labels);
  const conflicts = all.filter(c => !existing.has(signature(c)) || [c.nodeId,...c.otherIds,...(c.edgeIds ?? []),...(c.collectionIds ?? [])].some(id=>touched.has(id)));
  return {conflicts,all,geometry:measured.after.geometry,labels:measured.after.labels,
    collections:(after.collections ?? []).map(c=>({id:c.id,...collectionBounds(c,after.nodes,measured.after.geometry)}))};
}
