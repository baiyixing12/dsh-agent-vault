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
import { randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

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

  // ------------------------------------------------- 真·会话日志（不是"记忆"）

  const dshHome = (config && config.dshHome) || process.env.DSH_HOME || '/root/.dsh';
  const sessionsRoot = join(dshHome, 'sessions');
  const workspaceFile = join(dshHome, 'storages', 'workspace.json');

  /** 与 @deepseek-ai/dsh-session-persistence-jsonl 的 projectKey 完全一致。 */
  function projectKey(cwd) {
    if (!cwd.length) throw new Error('空的目录路径');
    let readable = '';
    let separatorRun = false;
    for (let i = 0; i < cwd.length; i += 1) {
      const code = cwd.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-';
        separatorRun = true;
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch;
        separatorRun = false;
      } else {
        readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
        separatorRun = false;
      }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
  }

  const logPath = (cwd, sessionId) => join(sessionsRoot, projectKey(cwd), sessionId, 'session.v4.jsonl.zstd');

  /** 一条既有消息 → 一条 DSH 会话事件（形状照真实日志）。 */
  function eventOf(message, seq, time, turn) {
    if (message.role === 'assistant') {
      return {
        type: 'assistant/message', seq, time,
        data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: message.text }] } },
      };
    }
    if (message.role === 'system') {
      return {
        type: 'system/message', seq, time,
        data: { turn, step: 1, message: { role: 'system', content: [{ type: 'text', text: message.text }] } },
      };
    }
    return {
      type: 'user/message', seq, time,
      data: {
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Asia/Shanghai' },
        role: 'user',
        id: randomUUID(),
      },
      surfaceOp: 'append',
    };
  }

  function buildLog({ messages, cwd, title, sessionId, turnStart = 1 }) {
    const id = sessionId || `session-${randomUUID()}`;
    const createdAt = Date.now();
    const lines = [JSON.stringify({
      type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0,
      agentPreset: (config && config.agentPreset) || 'standard',
    })];
    let seq = 1;
    let turn = turnStart;
    for (const message of messages) {
      if (!message || !message.text || !String(message.text).trim()) continue;
      lines.push(JSON.stringify(eventOf(message, seq, createdAt + seq * 10, turn)));
      if (message.role === 'assistant') turn += 1;
      seq += 1;
    }
    if (title) {
      lines.push(JSON.stringify({
        type: 'session/title', seq, time: createdAt + seq * 10,
        data: { title: String(title).slice(0, 80), messageSeqs: [1], source: { kind: 'fallback' } },
      }));
    }
    return { id, createdAt, lines };
  }

  /** 读一份既有日志，取回它的 cwd / 最大 seq / 最多帧数。 */
  function inspectLog(file) {
    const buf = readFileSync(file);
    const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
    const offsets = [];
    let at = 0;
    while ((at = buf.indexOf(MAGIC, at)) !== -1) { offsets.push(at); at += 4; }
    let text = '';
    let frames = 0;
    for (let i = 0; i < offsets.length; i += 1) {
      const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
      try { text += zstdDecompressSync(buf.subarray(offsets[i], end)).toString('utf8'); frames += 1; } catch { /* 跳过坏帧 */ }
    }
    let header = null;
    let maxSeq = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'session' && !header) header = event;
        if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
      } catch { /* 忽略 */ }
    }
    return { header, maxSeq, frames, bytes: buf.length };
  }

  /** 把新消息作为一帧追加到既有会话（就是"不断同步"的机制）。 */
  function appendToLog(sessionId, cwd, messages) {
    const file = logPath(cwd, sessionId);
    if (!existsSync(file)) return null;
    const info = inspectLog(file);
    const built = buildLog({ messages, cwd, sessionId });
    const fresh = built.lines.slice(1).map((line) => {
      const event = JSON.parse(line);
      if (typeof event.seq === 'number') event.seq += info.maxSeq;
      return JSON.stringify(event);
    });
    if (fresh.length === 0) return { appended: 0, maxSeq: info.maxSeq };
    appendFileSync(file, zstdCompressSync(Buffer.from(`${fresh.join('\n')}\n`)), { mode: 0o600 });
    return { appended: fresh.length, maxSeq: info.maxSeq + fresh.length };
  }

  /** 让新会话出现在侧栏：登记进 workspace.json（先备份）。 */
  function registerInWorkspace(cwd, sessionId, title) {
    let registry;
    try { registry = JSON.parse(readFileSync(workspaceFile, 'utf8')); } catch { return { registered: false, reason: 'workspace.json 读不到' }; }
    const table = registry.tables && registry.tables.workspaces;
    if (!table || !Array.isArray(registry.global && registry.global.workspaceIds)) return { registered: false, reason: 'workspace.json 结构不认识' };
    try { writeFileSync(`${workspaceFile}.bak`, readFileSync(workspaceFile), { mode: 0o600 }); } catch { /* 备份失败也继续 */ }
    let entry = Object.entries(table).find(([, value]) => value && value.path === cwd);
    if (!entry) {
      const id = randomUUID();
      table[id] = { path: cwd, title: title || cwd.split('/').filter(Boolean).pop() || cwd, sessionIds: [sessionId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      registry.global.workspaceIds.unshift(id);
      entry = [id, table[id]];
    } else {
      const list = Array.isArray(entry[1].sessionIds) ? entry[1].sessionIds : [];
      entry[1].sessionIds = [sessionId, ...list.filter((value) => value !== sessionId)];
      entry[1].updatedAt = new Date().toISOString();
    }
    writeFileSync(workspaceFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    return { registered: true, workspaceId: entry[0] };
  }

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

    if (action === 'previewSession' || action === 'writeSession') {
      const raw = typeof payload.text === 'string' ? payload.text.replace(/^\uFEFF/, '') : payload.text;
      const messages = Array.isArray(payload.messages) ? payload.messages : extractMessages(raw);
      const cwd = String(payload.cwd || '/sdcard/dsh').trim();
      if (!cwd.startsWith('/')) return { error: '目标目录要写绝对路径' };
      if (messages.length === 0) return { error: '没解析出消息' };
      const built = buildLog({ messages, cwd, title: payload.title });
      if (action === 'previewSession') {
        return {
          dir: root, cwd, projectKey: projectKey(cwd), sessionId: built.id,
          path: logPath(cwd, built.id), events: built.lines.length - 1, messages: messages.length,
          chars: messages.reduce((sum, message) => sum + String(message.text || '').length, 0),
          head: built.lines.slice(0, 3),
        };
      }
      const target = logPath(cwd, built.id);
      mkdirSync(join(sessionsRoot, projectKey(cwd), built.id), { recursive: true });
      writeFileSync(target, zstdCompressSync(Buffer.from(`${built.lines.join('\n')}\n`)), { mode: 0o600 });
      const registration = registerInWorkspace(cwd, built.id, payload.title);
      return { ...snapshot(sessionId), written: { sessionId: built.id, path: target, events: built.lines.length - 1, ...registration } };
    }

    if (action === 'syncSession') {
      const raw = typeof payload.text === 'string' ? payload.text.replace(/^\uFEFF/, '') : payload.text;
      const messages = Array.isArray(payload.messages) ? payload.messages : extractMessages(raw);
      const cwd = String(payload.cwd || '/sdcard/dsh').trim();
      const targetSession = String(payload.targetSessionId || '').trim();
      if (!targetSession || !cwd.startsWith('/')) return { error: '同步要指定 targetSessionId 与绝对 cwd' };
      if (messages.length === 0) return { error: '没解析出新消息' };
      const result = appendToLog(targetSession, cwd, messages);
      if (!result) return { error: `找不到会话日志：${logPath(cwd, targetSession)}` };
      return { ...snapshot(sessionId), synced: { sessionId: targetSession, ...result } };
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

  /** 给一个窗口注册注入段；返回 disposer。 */
  const registerFor = (agent) => {
    const owner = agent.ctx;
    return owner.effect(() => owner.systemPrompt.section({
      name: 'agent-vault',
      order: SECTION_ORDER,
      interpolate: false,
      text: () => compose(agent.id),
    }), 'agent-vault: window section');
  };

  const attach = (agent) => {
    const previous = sectionDisposers.get(agent.id);
    if (previous) { try { previous(); } catch { /* 已释放 */ } }
    sectionDisposers.set(agent.id, registerFor(agent));
  };

  // 每个窗口：绑定谁就注入谁
  ctx.on('agent/created', ({ agent }) => attach(agent));

  // 插件是后装的：已经开着的窗口也要补上（否则当前这个窗口要等重开才生效）
  ctx.inject(['agents'], (agentsCtx) => {
    agentsCtx.effect(() => {
      try {
        for (const agent of agentsCtx.agents.list()) {
          if (!sectionDisposers.has(agent.id)) attach(agent);
        }
      } catch (error) {
        ctx.logger?.warn?.(`agent-vault: 补注册现存窗口失败 ${error && error.message}`);
      }
      return () => {};
    }, 'agent-vault: existing windows');
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
