// Shared between the composer control and submission. Capture before preparing
// attachments/flush; an async send must not pick up a later composer choice.
export function createPermissionClient(api) {
  const values = new Map(), changes = new Map(), listeners = new Set();
  function publish(sessionId, value) {
    if (!values.has(sessionId) || value.revision >= values.get(sessionId).revision) {
      values.set(sessionId, value);
      for (const listener of listeners) listener(sessionId, value);
    }
    return values.get(sessionId);
  }
  const get = async sessionId => publish(sessionId, await api('permissions?sessionId=' + encodeURIComponent(sessionId), null, 'GET'));
  return {
    peek: sessionId => values.get(sessionId), get,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    change(sessionId, mode) {
      const task = (async () => {
        const current = values.get(sessionId) ?? await get(sessionId);
        try { return publish(sessionId, await api('permissions', { sessionId, mode, revision: current.revision })); }
        catch (cause) { await get(sessionId).catch(() => {}); throw cause; }
      })();
      changes.set(sessionId, task);
      const clear = () => { if (changes.get(sessionId) === task) changes.delete(sessionId); };
      task.then(clear, clear); return task;
    },
    async snapshot(sessionId) {
      const currentChange = changes.get(sessionId);
      return { ...(currentChange ? await currentChange : values.get(sessionId) ?? await get(sessionId)) };
    },
    async accepted(sessionId, requestId) {
      // A failed acknowledgement is not a failed message. The native inserted
      // and claimed events also consume once-only permissions idempotently.
      try { publish(sessionId, await api('permissions/accepted', {sessionId,requestId})); }
      catch { await get(sessionId).catch(() => {}); }
    },
  };
}
