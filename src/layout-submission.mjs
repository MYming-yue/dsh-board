// Keep the task snapshot outside message text and bind it to native admission.
export const LAYOUT_REQUEST = '整理白板布局。仅调整本次任务范围内的卡片位置，按内容与已有关系改善逻辑呈现和阅读观感；先读取布局任务，再提交候选坐标。';
export function layoutSession(session, snapshot, transport) {
    return new Proxy(session, {
        get(target, key) {
            if (key === 'prompt')
                return async (content, mode, signal, requestId = crypto.randomUUID()) => {
                    const task = await transport.stage({ ...snapshot, sessionId: target.sessionId, requestId }, signal);
                    try {
                        const result = await target.prompt(content, mode, signal, requestId);
                        if (!result.ok)
                            await transport.cancel(task.id).catch(() => { });
                        else
                            transport.accepted(task);
                        return result;
                    }
                    catch (error) {
                        // Admission may have succeeded despite a lost response. Preserve the
                        // task ID so the user can cancel it and avoid a second paid request.
                        transport.uncertain(task, error);
                        throw error;
                    }
                };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
