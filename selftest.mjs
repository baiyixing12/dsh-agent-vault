/** 自测：假 ctx 走 apply()，验证智能体创建/注入/累积日志/导入解析/绑定隔离。 */
import { apply } from './index.js';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const DIR = '/tmp/agent-vault-selftest';
rmSync(DIR, { recursive: true, force: true });

const routes = [], listeners = new Map();
const fakeCtx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a) },
  inject: (services, callback) => callback({ ...fakeCtx, connection: { registerFetchRoute: (owner, route) => routes.push(route) } }),
  on: (event, handler) => listeners.set(event, handler),
  effect: (fn) => { const dispose = fn(); return () => dispose && dispose(); },
};
apply(fakeCtx, { dir: DIR });

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

console.log(fail.length === 0 ? '\n全部通过' : `\n失败 ${fail.length} 项：${fail.join(', ')}`);
process.exit(fail.length === 0 ? 0 : 1);
