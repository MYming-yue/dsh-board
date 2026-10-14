import React, { useEffect, useRef, useState } from 'react';

export function GuideSettings({ api }) {
  const [guide, setGuide] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const editing = useRef({ loaded: false, revision: null, original: '', text: '' });
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const reading = useRef(false);
  const reload = useRef(null);
  function accept(next, force) {
    setGuide(next);
    const current = editing.current;
    if (force || !current.loaded || current.text === current.original) {
      editing.current = { loaded: true, revision: next.revision, original: next.text, text: next.text };
      setText(next.text); setStale(false);
    } else setStale(next.revision !== current.revision);
  }
  useEffect(() => {
    let stopped = false, timer;
    async function load(force = false) {
      if (inFlight.current || reading.current) return;
      if (force) { reading.current = true; setReloading(true); }
      const request = ++sequence.current;
      try {
        const next = await api('guide', null, 'GET');
        if (!stopped && request === sequence.current) { accept(next, force); setError(null); }
      } catch(cause) { if (!stopped && request === sequence.current) setError(cause.message); }
      finally { if(force) { reading.current=false;if(!stopped)setReloading(false); } }
    }
    reload.current = () => { setNotice(null); void load(true); };
    async function tick() {
      try { await load(); } finally { if (!stopped) timer = setTimeout(tick, 1500); }
    }
    void tick();
    return () => { stopped = true; clearTimeout(timer); sequence.current++; };
  }, [api]);
  function edit(value) {
    editing.current.text = value; setText(value); setNotice(null); setError(null);
  }
  async function save() {
    if (inFlight.current || reading.current) return;
    inFlight.current = true; sequence.current++; setSaving(true); setError(null); setNotice(null);
    try {
      const next = await api('guide', { text: editing.current.text, revision: editing.current.revision });
      accept(next, true);
      setNotice(next.text.trim() ? '已保存，后续模型请求会使用这份方法说明。' : '已保存空说明；后续请求保留固定协作规则。');
    } catch(cause) {
      setError(cause.message);
      if (cause.code === 'E_GUIDE_CONFLICT') setStale(true);
    } finally { inFlight.current = false; setSaving(false); }
  }
  const dirty = text !== editing.current.original;
  return <div className="dsh-board-guide-settings">
    <h3>白板使用方法提示词</h3>
    <p>这份说明同时供你阅读和 AI 使用。可以在这里编辑，也可以用本地编辑器修改文件；写法建议会用于后续模型请求。</p>
    {guide && <p className="dsh-board-guide-path">本地文件：<code>{guide.path}</code></p>}
    {guide?.error && <p role="alert">{guide.error} 编辑器显示最近有效的说明，原文件保留。</p>}
    <label className="dsh-board-guide-label" htmlFor="dsh-board-guide-text">方法说明</label>
    <textarea id="dsh-board-guide-text" aria-label="白板使用方法提示词" value={text} disabled={!guide || saving || reloading}
      onChange={event => edit(event.target.value)} spellCheck={false} />
    <div className="dsh-board-guide-actions">
      <button type="button" onClick={() => void save()} disabled={!guide?.revision || saving || reloading || stale || (!dirty && !guide.error)}>保存修改</button>
      <button type="button" onClick={() => { edit(guide.defaultText); setNotice('标准方法已载入编辑器，点击“保存修改”后生效。'); }} disabled={!guide || saving || reloading}>载入标准方法</button>
      <button type="button" onClick={() => reload.current?.()} disabled={!guide || saving || reloading}>重新读取本地文件</button>
    </div>
    <p role="status">{saving ? '正在保存…' : reloading ? '正在读取本地文件…' : stale ? '本地文件有更新，当前编辑已保留。请先复制需要保留的内容，再重新读取并核对。' : notice ?? (dirty ? '有未保存修改。' : guide ? '与本地文件一致。' : '正在读取方法说明…')}</p>
    {error && <p role="alert">{error}</p>}
    <p>最多 16 KiB。保存时保留上一版文件；留空可停用写法建议。批次校验与布局任务范围继续由程序保证。</p>
    <details><summary>查看提供的标准方法</summary><pre>{guide?.defaultText}</pre></details>
  </div>;
}
