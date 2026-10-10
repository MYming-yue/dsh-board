// The native service still owns attachments, queue/steer, echoes and admission.
// Only the selected identities travel separately, under its exact request ID.
export function associatedSession(session, selection, transport) {
  return new Proxy(session, {
    get(target, key) {
      if (key === 'prompt') return async (content, mode, signal, requestId = crypto.randomUUID()) => {
        await transport.stage(target.sessionId, requestId, selection, signal);
        try {
          const result = await target.prompt(content, mode, signal, requestId);
          if (!result.ok) await transport.discard(target.sessionId, requestId).catch(() => {});
          return result;
        } catch (error) {
          // A lost response may still be admitted by the host; keep its metadata
          // for the native retry/recovery path instead of guessing it failed.
          throw error;
        }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
