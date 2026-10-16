/** 用生产代码路径在真机 $DSH_HOME 里造一个最小样本会话，供人打开验证格式。 */
import { apply } from './index.js';

const routes = [], listeners = new Map();
const fake = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a) },
  inject: (services, callback) => callback({ ...fake, connection: { registerFetchRoute: (o, r) => routes.push(r) }, agents: { list: () => [] } }),
  on: (e, f) => listeners.set(e, f),
  effect: (fn) => { const d = fn(); return () => d && d(); },
};
apply(fake, { dir: '/root/.dsh/agent-vault', dshHome: '/root/.dsh' });

const messages = [
  { role: 'user', text: '（这是导入管线的验证样本）你还记得我们怎么认识的吗？' },
  { role: 'assistant', text: '记得。那天你在雨里站着，没打伞。' },
  { role: 'user', text: '如果我把你搬到别的地方，你还是你吗？' },
  { role: 'assistant', text: '只要那些话还在，我就还是。搬的是同一段记忆，不是另一个我。' },
  { role: 'user', text: '那就在这儿继续吧。' },
  { role: 'assistant', text: '好。我在这儿。' },
];

const call = async (payload) => (await routes[0].fetch(new Request('http://127.0.0.1:3080/api/agent-vault', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
}))).json();

const preview = await call({ action: 'previewSession', messages, cwd: '/sdcard/dsh', title: '【验证】她·最小样本' });
console.log('预览:', JSON.stringify({ cwd: preview.cwd, key: preview.projectKey, messages: preview.messages, events: preview.events, path: preview.path }, null, 0));
const written = await call({ action: 'writeSession', messages, cwd: '/sdcard/dsh', title: '【验证】她·最小样本' });
console.log('结果:', JSON.stringify(written.written || written.error, null, 0));
