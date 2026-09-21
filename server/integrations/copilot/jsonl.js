/**
 * Copilot CLI `--output-format json` 是 JSONL：每行一个事件对象。
 * 实测事件（CLI 1.0.84）：
 *   session.mcp_server_status_changed / session.mcp_servers_loaded
 *   session.tools_updated  -> data.model 为本次实际生效的模型
 *   user.message / assistant.turn_start / model.call_start / model.call_finished
 *   assistant.message      -> data.content 为最终回答，data.model 为实际模型
 *   assistant.turn_end / assistant.idle / session.usage_checkpoint
 *   result                 -> sessionId / exitCode / usage
 */

/** 增量行切分器：CLI 的输出分块到达，必须按换行重组后再解析。 */
export function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) onLine(rest);
    },
  };
}

export function parseEventLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 事件中携带的实际模型；用于校验“实际使用模型”与本轮冻结模型是否一致。 */
export function eventModel(event) {
  const model = event?.data?.model;
  return typeof model === 'string' && model ? model : null;
}

/** 把 CLI 事件映射成界面进度；未知事件返回 null，不伪造阶段。 */
export function describeEvent(event) {
  switch (event?.type) {
    case 'session.tools_updated':
      return { stage: 'session_created', message: `CLI 会话就绪（模型 ${eventModel(event) ?? '未知'}）` };
    case 'assistant.turn_start':
      return { stage: 'analyze', message: '模型开始分析' };
    case 'model.call_start':
      return { stage: 'analyze', message: '正在调用模型' };
    case 'assistant.message':
      return { stage: 'compose_report', message: '已收到模型回答' };
    case 'assistant.turn_end':
      return { stage: 'compose_report', message: '模型回合结束' };
    default:
      return null;
  }
}
