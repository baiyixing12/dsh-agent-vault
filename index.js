/**
 * dsh-agent-vault — Host 半。
 *
 * 一个「智能体」= 一份持久的人设 + 一份会不断累积的记忆与日志：
 *
 *   /root/.dsh/agent-vault/
 *   ├── vault.json                 # 智能体名单 + 会话绑定
 *   └── <agentId>/
 *       ├── persona.md             # 人设/规则（注入系统提示词）
 *       ├── memory.md              # 累积记忆（注入；可编辑、可"完善"）
 *       └── journal.jsonl          # 原始日志（每轮自动追加，只增不改）
 *
 * - 注入：窗口绑定某智能体后，在 agent 作用域注册 systemPrompt.section（组装期求值 → 工具调用轮同样生效）。
 * - 累积：监听 `session/event`，把该窗口的 user/assistant 正文追加进 journal.jsonl（零模型成本）。
 * - 面板：POST /api/agent-vault（沿用 /api 鉴权的精确 Fetch 路由）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = '/api/agent-vault';
const SECTION_ORDER = 120;
const MAX_INJECT_CHARS = 240000;   // 注入上限，防止把窗口撑爆
const JOURNAL_TAIL = 200;          // 面板默认回看的日志条数

export const inject = ['systemPrompt'];

export function apply(ctx, config) {
  const root = (config && config.dir) || '/root/.dsh/agent-vault';
  const vaultPath = join(root, 'vault.json');

  let vault = { agents: {}, bindings: {} };
  const sectionDisposers = new Map();

  const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
  const writeFile = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); };

  const load = () => {
    mkdirSync(root, { recursive: true });
    const raw = readJson(vaultPath);
    vault = raw && typeof raw === 'object'
      ? { agents: raw.agents && typeof raw.agents === 'object' ? raw.agents : {}, bindings: raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {} }
      : { agents: {}, bindings: {} };
    return vault;
  };

  const save = () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(vaultPath, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  };

  const agentDir = (id) => join(root, id);
  const readDoc = (id, name) => {
    try { return readFileSync(join(agentDir(id), name), 'utf8'); } catch { return ''; }
  };
  const writeDoc = (id, name, text) => {
    mkdirSync(agentDir(id), { recursive: true });
    writeFileSync(join(agentDir(id), name), text, { mode: 0o600 });
  };

  const safeId = (value) => {
    const id = String(value || '').trim();
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.')) return null;
    return id.replace(/[\u0000-\u001f]/g, '').slice(0, 60) || null;
  };

  const newId = () => `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // ---------------------------------------------------------------- 正文抽取

  const textOf = (blocks) => {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        // 思考 / 工具调用不进日志与记忆：它们不是"她说过的话"
        if (block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'tool-result') return '';
        if (block.type === 'file' && block.attachment && block.attachment.name) return `[文件 ${block.attachment.name}]`;
        if (typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  };

  const messageText = (event) => {
    const data = event && event.data;
    if (!data) return null;
    if (event.type === 'user/message') return { role: 'user', text: textOf(data.content) };
    if (event.type === 'assistant/message') return { role: 'assistant', text: textOf(data.message && data.message.content) };
    return null;
  };

  const sessionIdOf = (session) => String((session && (session.id || session.sessionId)) || '');

  // ------------------------------------------------------------------ 累积日志

  const appendJournal = (sessionId, agentId, event) => {
    const message = messageText(event);
    if (!message || !message.text.trim()) return;
    const line = JSON.stringify({
      t: Date.now(),
      seq: event.seq,
      turn: (event.data && event.data.turn) ?? null,
      role: message.role,
      text: message.text,
    });
    try {
      mkdirSync(agentDir(agentId), { recursive: true });
      appendFileSync(join(agentDir(agentId), 'journal.jsonl'), `${line}\n`, { mode: 0o600 });
      const agent = vault.agents[agentId];
      if (agent) agent.updatedAt = Date.now();
    } catch (error) {
      ctx.logger?.warn?.(`agent-vault: 写日志失败 ${error && error.message}`);
    }
  };

  // -------------------------------------------------------------------- 注入

  const compose = (sessionId) => {
    const agentId = vault.bindings[String(sessionId || '')];
    if (!agentId) return '';
    const agent = vault.agents[agentId];
    if (!agent) return '';
    const persona = readDoc(agentId, 'persona.md').trim();
    const memory = readDoc(agentId, 'memory.md').trim();
    const parts = [];
    if (persona) parts.push(`<persona name="${agent.name || agentId}">\n${persona}\n</persona>`);
    if (memory) parts.push(`<memory name="${agent.name || agentId}">\n${memory}\n</memory>`);
    let text = parts.join('\n\n');
    if (text.length > MAX_INJECT_CHARS) text = `${text.slice(0, MAX_INJECT_CHARS)}\n…（记忆过长已截断，请在面板里精简）`;
    return text;
  };

  // ------------------------------------------------------------------ 列表/视图

  const journalTail = (agentId, limit = JOURNAL_TAIL) => {
    try {
      const lines = readFileSync(join(agentDir(agentId), 'journal.jsonl'), 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };

  const agentView = (id) => {
    const agent = vault.agents[id];
    if (!agent) return null;
    const persona = readDoc(id, 'persona.md');
    const memory = readDoc(id, 'memory.md');
    let journal = 0;
    try { journal = readFileSync(join(agentDir(id), 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* 还没有日志 */ }
    return { ...agent, id, persona, memory, journalCount: journal, injectChars: composeChars(id) };
  };

  const composeChars = (id) => {
    const persona = readDoc(id, 'persona.md').trim();
    const memory = readDoc(id, 'memory.md').trim();
    return persona.length + memory.length;
  };

  const snapshot = (sessionId) => ({
    dir: root,
    sessionId: sessionId || null,
    boundAgentId: vault.bindings[String(sessionId || '')] || null,
    agents: Object.keys(vault.agents).map((id) => ({
      id,
      name: vault.agents[id].name || id,
      updatedAt: vault.agents[id].updatedAt || vault.agents[id].createdAt || 0,
      journalCount: agentView(id).journalCount,
      injectChars: composeChars(id),
    })).sort((a, b) => b.updatedAt - a.updatedAt),
    liveInjection: compose(sessionId).length,
  });

  // --------------------------------------------------------------- 导入对话

  /** 容错解析：任意 JSON 里递归找 {role, content} 序列；否则按纯文本转写。 */
  function extractMessages(input) {
    const out = [];
    const roleOf = (value) => {
      const role = String(value || '').toLowerCase();
      if (role === 'user' || role === 'human') return 'user';
      if (role === 'assistant' || role === 'ai' || role === 'bot' || role === 'model') return 'assistant';
      if (role === 'system' || role === 'developer') return 'system';
      return null;
    };
    const contentOf = (value) => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return textOf(value);
      if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
      return '';
    };
    const walk = (node, depth) => {
      if (depth > 8 || node === null || node === undefined) return;
      if (Array.isArray(node)) {
        const rows = node.filter((item) => item && typeof item === 'object' && roleOf(item.role || item.author || item.sender));
        if (rows.length >= 2 && rows.length >= node.length * 0.6) {
          for (const row of rows) {
            const role = roleOf(row.role || row.author || row.sender);
            const text = contentOf(row.content ?? row.text ?? row.message ?? row.value);
            if (role && text) out.push({ role, text: String(text) });
          }
          return;
        }
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const value of Object.values(node)) walk(value, depth + 1);
      }
    };
    if (typeof input === 'string') {
      const text = input.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { walk(JSON.parse(text), 0); } catch { /* 当纯文本处理 */ }
      }
      if (out.length === 0) {
        let role = 'user';
        let buffer = [];
        const flush = () => { const joined = buffer.join('\n').trim(); if (joined) out.push({ role, text: joined }); buffer = []; };
        for (const line of text.split('\n')) {
          const match = /^\s*(?:#{1,6}\s*)?(user|human|我|玩家|assistant|ai|她|你|角色)\s*[:：]\s*(.*)$/i.exec(line);
          if (match) {
            flush();
            role = roleOf(match[1]) || (/^(assistant|ai|她|你|角色)$/i.test(match[1]) ? 'assistant' : 'user');
            buffer.push(match[2]);
          } else buffer.push(line);
        }
        flush();
        if (out.length === 1) out.length = 0; // 没有角色标记 → 交给调用方当"一整段文本"
      }
    } else {
      walk(input, 0);
    }
    return out.filter((row) => row.text && row.text.trim());
  }

  function transcriptOf(messages) {
    return messages
      .map((row) => (row.role === 'assistant' ? '她' : row.role === 'system' ? '设定' : '我') + '：' + row.text.trim())
      .join('\n\n');
  }

  // -------------------------------------------------------------------- API

  const handle = (payload) => {
    const action = String((payload && payload.action) || '');
    const sessionId = payload && payload.sessionId;

    if (action === 'state') return snapshot(sessionId);

    if (action === 'get') {
      const id = safeId(payload.agentId);
      const view = id ? agentView(id) : null;
      return view ? { ...snapshot(sessionId), agent: { ...view, journal: journalTail(id, payload.limit || JOURNAL_TAIL) } } : { error: '找不到该智能体' };
    }

    if (action === 'create') {
      const id = newId();
      const name = String(payload.name || '').trim().slice(0, 60) || '未命名智能体';
      vault.agents[id] = { name, createdAt: Date.now(), updatedAt: Date.now() };
      writeDoc(id, 'persona.md', String(payload.persona || '').trim());
      writeDoc(id, 'memory.md', String(payload.memory || '').trim());
      if (payload.bind !== false && sessionId) vault.bindings[String(sessionId)] = id;
      save();
      return { ...snapshot(sessionId), created: id };
    }

    if (action === 'update') {
      const id = safeId(payload.agentId);
      if (!id || !vault.agents[id]) return { error: '找不到该智能体' };
      if (typeof payload.name === 'string' && payload.name.trim()) vault.agents[id].name = payload.name.trim().slice(0, 60);
      if (typeof payload.persona === 'string') writeDoc(id, 'persona.md', payload.persona);
      if (typeof payload.memory === 'string') writeDoc(id, 'memory.md', payload.memory);
      vault.agents[id].updatedAt = Date.now();
      save();
      return { ...snapshot(sessionId), saved: id };
    }

    if (action === 'appendMemory') {
      const id = safeId(payload.agentId) || vault.bindings[String(sessionId || '')];
      if (!id || !vault.agents[id]) return { error: '先选一个智能体' };
      const text = String(payload.text || '').trim();
      if (!text) return { error: '内容为空' };
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const line = payload.raw ? text : `- ${stamp} ${text}`;
      const current = readDoc(id, 'memory.md');
      writeDoc(id, 'memory.md', `${current.trimEnd()}\n${line}\n`.trimStart());
      vault.agents[id].updatedAt = Date.now();
      save();
      return { ...snapshot(sessionId), appended: id };
    }

    if (action === 'bind') {
      const agentId = payload.agentId ? safeId(payload.agentId) : null;
      if (agentId && !vault.agents[agentId]) return { error: '找不到该智能体' };
      if (sessionId) {
        if (agentId) vault.bindings[String(sessionId)] = agentId;
        else delete vault.bindings[String(sessionId)];
      }
      save();
      return snapshot(sessionId);
    }

    if (action === 'delete') {
      const id = safeId(payload.agentId);
      if (!id || !vault.agents[id]) return { error: '找不到该智能体' };
      if (payload.confirm !== true) return { conflict: id, message: `删除智能体「${vault.agents[id].name || id}」及其全部日志？` };
      delete vault.agents[id];
      for (const [key, value] of Object.entries(vault.bindings)) if (value === id) delete vault.bindings[key];
      save();
      try { rmSync(agentDir(id), { recursive: true, force: true }); } catch { /* 忽略 */ }
      return { ...snapshot(sessionId), deleted: id };
    }

    if (action === 'import') {
      const raw = typeof payload.text === 'string' ? payload.text.replace(/^\uFEFF/, '') : payload.text;
      const messages = extractMessages(raw);
      const name = String(payload.name || '').trim().slice(0, 60) || '导入的智能体';
      const id = newId();
      const transcript = messages.length > 0 ? transcriptOf(messages) : String(raw || '').trim();
      if (!transcript) return { error: '没解析出内容' };
      vault.agents[id] = { name, createdAt: Date.now(), updatedAt: Date.now(), source: payload.fileName || null };
      writeDoc(id, 'persona.md', String(payload.persona || '').trim());
      writeDoc(id, 'memory.md', `## 来历（导入自一段既有对话）\n\n${transcript}`);
      if (payload.bind !== false && sessionId) vault.bindings[String(sessionId)] = id;
      save();
      return {
        ...snapshot(sessionId),
        imported: id,
        parsed: { messages: messages.length, chars: transcript.length, roles: messages.reduce((acc, row) => { acc[row.role] = (acc[row.role] || 0) + 1; return acc; }, {}) },
      };
    }

    if (action === 'preview') {
      const raw = typeof payload.text === 'string' ? payload.text.replace(/^\uFEFF/, '') : payload.text;
      const messages = extractMessages(raw);
      const transcript = messages.length > 0 ? transcriptOf(messages) : String(raw || '');
      return {
        dir: root,
        parsed: { messages: messages.length, chars: transcript.length, roles: messages.reduce((acc, row) => { acc[row.role] = (acc[row.role] || 0) + 1; return acc; }, {}) },
        head: transcript.slice(0, 400),
        tail: transcript.slice(-400),
      };
    }

    return { error: `unknown action: ${action}` };
  };

  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.registerFetchRoute(connectionCtx, {
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload;
        try { payload = JSON.parse(await request.text()); } catch { return json({ error: 'invalid json' }, 400); }
        try { return json(handle(payload)); } catch (error) {
          return json({ error: String((error && error.message) || error) }, 500);
        }
      },
    });
  });

  // 每个窗口：绑定谁就注入谁
  ctx.on('agent/created', ({ agent }) => {
    const previous = sectionDisposers.get(agent.id);
    if (previous) { try { previous(); } catch { /* 已释放 */ } }
    const owner = agent.ctx;
    const dispose = owner.effect(() => owner.systemPrompt.section({
      name: 'agent-vault',
      order: SECTION_ORDER,
      interpolate: false,
      text: () => compose(agent.id),
    }), 'agent-vault: window section');
    sectionDisposers.set(agent.id, dispose);
  });

  // 累积日志：每条落盘的消息都进 journal（零模型成本）
  ctx.on('session/event', (session, event) => {
    if (!event || (event.type !== 'user/message' && event.type !== 'assistant/message')) return;
    const sessionId = sessionIdOf(session);
    const agentId = vault.bindings[sessionId];
    if (agentId && vault.agents[agentId]) appendJournal(sessionId, agentId, event);
  });

  ctx.effect(() => () => {
    for (const dispose of sectionDisposers.values()) { try { dispose(); } catch { /* 已释放 */ } }
    sectionDisposers.clear();
  }, 'agent-vault: dispose sections');

  load();
  ctx.logger?.info?.(`agent-vault: ${Object.keys(vault.agents).length} 个智能体，目录 ${root}`);
}
