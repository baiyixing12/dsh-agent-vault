/** 自测：假 ctx 走 apply()，验证智能体创建/注入/累积日志/导入解析/绑定隔离。 */
import { apply } from './index.js';
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const DIR = '/tmp/agent-vault-selftest';
const HOME = '/tmp/agent-vault-selftest-home';
rmSync(DIR, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
mkdirSync(`${HOME}/storages`, { recursive: true });
writeFileSync(`${HOME}/storages/workspace.json`, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { 'ws-1': { path: '/sdcard/dsh', title: 'dsh', sessionIds: ['session-old'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } },
}, null, 2));

const routes = [], listeners = new Map();
// 模拟"插件装载前就已经开着的窗口"：它也必须被补注册
const legacySections = [];
const existingAgents = [{ id: 'sess-legacy', ctx: { effect: (fn) => { const d = fn(); return () => d && d(); }, systemPrompt: { section: (s) => { legacySections.push(s); return () => {}; } } } }];
const fakeCtx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a) },
  inject: (services, callback) => callback({
    ...fakeCtx,
    connection: { registerFetchRoute: (owner, route) => routes.push(route) },
    agents: { list: () => existingAgents },
  }),
  on: (event, handler) => listeners.set(event, handler),
  effect: (fn) => { const dispose = fn(); return () => dispose && dispose(); },
};
apply(fakeCtx, { dir: DIR, dshHome: HOME });

const sections = [];
const agentCtx = { effect: (fn) => { const dispose = fn(); return () => dispose && dispose(); }, systemPrompt: { section: (section) => { sections.push(section); return () => {}; } } };
listeners.get('agent/created')({ agent: { id: 'sess-A', ctx: agentCtx } });

const call = async (payload) => {
  const request = new Request('http://127.0.0.1:3080/api/agent-vault', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return (await routes[0].fetch(request)).json();
};
const fail = [];
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`); if (!ok) fail.push(label); };

const initial = await call({ action: 'state', sessionId: 'sess-A' });
check('初始无智能体、未绑定', initial.agents.length === 0 && initial.boundAgentId === null);
check('未绑定不注入', sections[0].text() === '');

const created = await call({ action: 'create', sessionId: 'sess-A', name: '小九', persona: '你叫小九，说话很短。' });
check('创建并自动绑定', Boolean(created.created) && created.boundAgentId === created.created);
check('人设进入注入', sections[0].text().includes('小九') && sections[0].text().includes('说话很短'));
check('注入带 section 名与顺序', sections[0].name === 'agent-vault' && sections[0].order === 120);
check('未绑定的别的窗口仍是空', (await call({ action: 'state', sessionId: 'sess-B' })).boundAgentId === null);

await call({ action: 'update', sessionId: 'sess-A', agentId: created.created, memory: '## 事实\n- 她怕黑。' });
check('记忆进入注入', sections[0].text().includes('她怕黑'));
await call({ action: 'appendMemory', sessionId: 'sess-A', agentId: created.created, text: '喜欢雨天' });
check('追加记忆落盘', sections[0].text().includes('喜欢雨天'));

// 累积日志：模拟两条消息落盘
const emitSessionEvent = listeners.get('session/event');
emitSessionEvent({ id: 'sess-A' }, { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '在吗' }] } });
emitSessionEvent({ id: 'sess-A' }, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '在。' }] } } });
emitSessionEvent({ id: 'sess-A' }, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'reasoning', text: '思考不该入库' }] } } });
emitSessionEvent({ id: 'sess-B' }, { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '别的窗口不该进' }] } });
const withJournal = await call({ action: 'get', sessionId: 'sess-A', agentId: created.created });
check('日志累积了 2 条', withJournal.agent.journalCount === 2, `${withJournal.agent.journalCount} 条`);
check('只收正文不收思考', withJournal.agent.journal.every((row) => !row.text.includes('思考')));
check('未绑定窗口的消息不进日志', !withJournal.agent.journal.some((row) => row.text.includes('别的窗口')));

// 导入一段既有对话（JSON）
const convo = JSON.stringify({ data: { messages: [
  { role: 'user', content: '你好，我是阿远。' },
  { role: 'assistant', content: '阿远，好久不见。' },
  { role: 'user', content: [{ type: 'text', text: '以后也要一起。' }] },
] } });
const preview = await call({ action: 'preview', text: convo });
check('导入预览解析出 3 条', preview.parsed.messages === 3, JSON.stringify(preview.parsed));
const imported = await call({ action: 'import', sessionId: 'sess-B', text: convo, name: '阿远的她' });
check('导入生成新智能体并绑定到目标窗口', Boolean(imported.imported));
check('导入内容进记忆', (await call({ action: 'get', sessionId: 'sess-B', agentId: imported.imported })).agent.memory.includes('阿远，好久不见'));

// 纯文本转写
const plain = await call({ action: 'preview', text: '我：今晚出来吗\n她：穿上外套，外面冷。' });
check('纯文本转写也能解析角色', plain.parsed.messages === 2 && plain.parsed.roles.assistant === 1, JSON.stringify(plain.parsed.roles));

// 解绑与删除
await call({ action: 'bind', sessionId: 'sess-A', agentId: null });
check('解绑后不注入', sections[0].text() === '');
const refused = await call({ action: 'delete', sessionId: 'sess-A', agentId: created.created });
check('删除需二次确认', Boolean(refused.conflict));
await call({ action: 'delete', sessionId: 'sess-A', agentId: created.created, confirm: true });
check('确认后删除、目录也没了', !existsSync(`${DIR}/${created.created}`));
check('vault.json 已同步', JSON.parse(readFileSync(`${DIR}/vault.json`, 'utf8')).agents[created.created] === undefined);
check('非法 id 被拒', Boolean((await call({ action: 'get', agentId: '../etc' })).error));

// 现存窗口补注册
check('插件后装也会给已开着的窗口注册', legacySections.length === 1 && legacySections[0].name === 'agent-vault');
const boundLegacy = await call({ action: 'bind', sessionId: 'sess-legacy', agentId: imported.imported });
check('现存窗口绑定后立刻注入', legacySections[0].text().includes('阿远，好久不见'), `${legacySections[0].text().length} 字`);


// ---- 真·会话日志：写入 / 增量追加 / 侧栏登记 ----
const convo2 = JSON.stringify([
  { role: 'user', content: '在吗' },
  { role: 'assistant', content: '在。' },
  { role: 'user', content: '今晚出来' },
  { role: 'assistant', content: '穿上外套。' },
]);
const previewSession = await call({ action: 'previewSession', text: convo2, cwd: '/sdcard/dsh', title: '她·续#1' });
check('会话预览：目录 slug 与真实算法一致', previewSession.projectKey === '--sdcard-dsh--', previewSession.projectKey);
check('会话预览：消息数正确（含标题共 5 个事件）', previewSession.messages === 4 && previewSession.events === 5, `msg=${previewSession.messages} ev=${previewSession.events}`);
check('会话预览不落盘', !existsSync(previewSession.path));

const written = await call({ action: 'writeSession', text: convo2, cwd: '/sdcard/dsh', title: '她·续#1' });
check('写了会话日志', written.written && existsSync(written.written.path));
check('侧栏已登记', written.written.registered === true);
const registry = JSON.parse(readFileSync(`${HOME}/storages/workspace.json`, 'utf8'));
const wsEntry = Object.values(registry.tables.workspaces).find((w) => w.path === '/sdcard/dsh');
check('登记进对应工作区且插到最前', Boolean(wsEntry) && wsEntry.sessionIds[0] === written.written.sessionId && wsEntry.sessionIds.includes('session-old'));
check('workspace.json 有备份', existsSync(`${HOME}/storages/workspace.json.bak`));

const raw = readFileSync(written.written.path);
const decoded = zstdDecompressSync(raw).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
check('首行是合法会话头', decoded[0].type === 'session' && decoded[0].version === 4 && decoded[0].cwd === '/sdcard/dsh'
  && decoded[0].id === written.written.sessionId && decoded[0].isSeeded === false);
check('消息事件角色与顺序正确',
  decoded.filter((e) => e.type === 'user/message').length === 2
  && decoded.filter((e) => e.type === 'assistant/message').length === 2
  && decoded[1].type === 'user/message' && decoded[2].type === 'assistant/message');
check('事件信封只有允许的键', decoded.slice(1).every((e) => Object.keys(e).every((k) =>
  ['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'].includes(k))));
check('seq 递增且 time 是整数', decoded.slice(1).every((e, i, arr) =>
  Number.isInteger(e.seq) && Number.isInteger(e.time) && (i === 0 || e.seq > arr[i - 1].seq)));
check('正文可回读', decoded.some((e) => JSON.stringify(e).includes('穿上外套')));
check('标题事件写入', decoded.some((e) => e.type === 'session/title' && e.data.title === '她·续#1'));

// 增量同步：把网页端的新几条追加到同一个会话
const beforeFrames = readFileSync(written.written.path).length;
const synced = await call({
  action: 'syncSession', cwd: '/sdcard/dsh', targetSessionId: written.written.sessionId, text: JSON.stringify([
    { role: 'user', content: '我又来了' },
    { role: 'assistant', content: '嗯，坐。' },
  ]),
});
check('追加同步成功', synced.synced && synced.synced.appended === 2, JSON.stringify(synced.synced || synced.error));
check('追加后 seq 继续（不冲突）', synced.synced.maxSeq > 6, `${synced.synced.maxSeq}`);
const afterText = (() => {
  const buf = readFileSync(written.written.path);
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
  const offs = [];
  let at = 0;
  while ((at = buf.indexOf(MAGIC, at)) !== -1) { offs.push(at); at += 4; }
  let out = '';
  for (let i = 0; i < offs.length; i += 1) {
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length;
    try { out += zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8'); } catch { /* 跳过 */ }
  }
  return out;
})();
check('追加内容确实进了日志', afterText.includes('我又来了') && afterText.includes('坐。'));
check('文件确实变长了（多帧追加）', readFileSync(written.written.path).length > beforeFrames);
const finalSeqs = afterText.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => typeof e.seq === 'number').map((e) => e.seq);
check('全日志 seq 无重复', new Set(finalSeqs).size === finalSeqs.length, `${finalSeqs.length} 条事件`);
check('同步到不存在的会话会报错', Boolean((await call({ action: 'syncSession', cwd: '/sdcard/dsh', targetSessionId: 'session-nope', text: convo2 })).error));

console.log(fail.length === 0 ? '\n全部通过' : `\n失败 ${fail.length} 项：${fail.join(', ')}`);
process.exit(fail.length === 0 ? 0 : 1);
