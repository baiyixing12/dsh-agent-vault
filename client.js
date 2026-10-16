/**
 * dsh-agent-vault — Client 半。
 * 设置页「智能体」+ 输入框左侧「智能体」按钮：把窗口绑到一个持久智能体，
 * 编辑人设与记忆、导入既有对话、看持续累积的日志。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-vault',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROUTE = '/api/agent-vault';

    let appCtx = null;

    const token = {
      panelBg: 'var(--dsw-alias-bg-overlay, rgba(30,30,33,0.98))',
      layer: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      dim: 'var(--dsw-alias-label-caption, rgba(127,127,127,1))',
      brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
    };

    const styles = {
      button: {
        display: 'inline-flex', alignItems: 'center', gap: 4, height: 26, padding: '0 8px',
        fontSize: 12, color: token.text, background: 'transparent',
        border: `1px solid ${token.border}`, borderRadius: 999, cursor: 'pointer',
      },
      panel: {
        position: 'fixed', right: 12, bottom: 78, zIndex: 60,
        width: 'min(94vw, 460px)', maxHeight: '72vh', overflowY: 'auto',
        background: token.panelBg, color: token.text,
        border: `1px solid ${token.border}`, borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)', padding: '10px 12px',
        fontSize: 13, lineHeight: 1.5,
      },
      head: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' },
      select: {
        flex: '1 1 140px', minWidth: 0, height: 28, borderRadius: 8, fontSize: 12,
        color: token.text, background: token.layer, border: `1px solid ${token.border}`,
      },
      ghost: {
        height: 26, padding: '0 8px', fontSize: 12, cursor: 'pointer',
        color: token.text, background: token.layer,
        border: `1px solid ${token.border}`, borderRadius: 8,
      },
      area: {
        width: '100%', boxSizing: 'border-box', minHeight: 120, resize: 'vertical',
        fontSize: 12, lineHeight: 1.5, fontFamily: 'inherit',
        color: token.text, background: token.layer,
        border: `1px solid ${token.border}`, borderRadius: 8, padding: 8,
      },
      label: { fontSize: 11, color: token.dim, margin: '8px 0 4px' },
      small: { fontSize: 11, color: token.dim },
      error: { fontSize: 11, color: '#ff8080', marginTop: 8 },
      logRow: { borderTop: `1px solid ${token.border}`, padding: '5px 0', fontSize: 12 },
      tab: { display: 'inline-flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' },
    };

    async function api(payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function currentSessionId() {
      try {
        const snapshot = appCtx && appCtx.sessions && appCtx.sessions.list.getSnapshot();
        const rows = Object.values((snapshot && snapshot.byId) || {});
        const focused = rows.find((row) => ((row && row.retainedBy && row.retainedBy.mainView) || 0) > 0);
        return (focused && focused.id) || (rows[0] && rows[0].id) || null;
      } catch {
        return null;
      }
    }

    function Panel({ onClose, inline }) {
      const [data, setData] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [tab, setTab] = React.useState('persona');
      const [persona, setPersona] = React.useState('');
      const [memory, setMemory] = React.useState('');
      const [name, setName] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const fileRef = React.useRef(null);

      const send = React.useCallback(async (payload) => {
        setBusy(true);
        try {
          const next = await api({ sessionId: currentSessionId(), ...payload });
          if (next && next.error) throw new Error(next.error);
          setError('');
          return next;
        } catch (cause) {
          setError(String((cause && cause.message) || cause));
          return null;
        } finally {
          setBusy(false);
        }
      }, []);

      const refresh = React.useCallback(async () => {
        const next = await send({ action: 'state' });
        if (!next) return;
        setData(next);
        if (next.boundAgentId) {
          const detailNext = await send({ action: 'get', agentId: next.boundAgentId });
          if (detailNext && detailNext.agent) {
            setDetail(detailNext.agent);
            setPersona(detailNext.agent.persona || '');
            setMemory(detailNext.agent.memory || '');
            setName(detailNext.agent.name || '');
          }
        } else {
          setDetail(null);
        }
      }, [send]);

      React.useEffect(() => { refresh(); }, [refresh]);
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape' && !inline) onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose, inline]);

      const bind = async (agentId) => {
        await send({ action: 'bind', agentId: agentId || null });
        await refresh();
      };

      const openAgent = async (agentId) => {
        const next = await send({ action: 'get', agentId });
        if (next && next.agent) {
          setDetail(next.agent);
          setPersona(next.agent.persona || '');
          setMemory(next.agent.memory || '');
          setName(next.agent.name || '');
        }
      };

      const save = async () => {
        if (!detail) return;
        await send({ action: 'update', agentId: detail.id, name, persona, memory });
        await refresh();
      };

      const importFile = async (event) => {
        const input = event.target;
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        let text;
        try { text = await file.text(); } catch { setError('读取文件失败'); return; }
        const preview = await send({ action: 'preview', text });
        if (!preview || !preview.parsed) return;
        const summary = `解析出 ${preview.parsed.messages} 条消息 / ${preview.parsed.chars} 字\n`
          + Object.entries(preview.parsed.roles).map(([role, count]) => `${role}:${count}`).join(' ') + '\n\n'
          + preview.head + '\n…\n' + preview.tail;
        const agentName = window.prompt(`给这个智能体起个名字：\n（预览）\n${summary}`.slice(0, 900),
          file.name.replace(/\.(json|txt|md)$/i, ''));
        if (agentName === null) return;
        const result = await send({ action: 'import', text, name: agentName, fileName: file.name });
        if (result && result.imported) await refresh();
      };

      const remove = async () => {
        if (!detail) return;
        if (!window.confirm(`删除智能体「${detail.name}」及其全部日志？不可撤销。`)) return;
        await send({ action: 'delete', agentId: detail.id, confirm: true });
        setDetail(null);
        await refresh();
      };

      const shell = inline
        ? { ...styles.panel, position: 'static', right: 'auto', bottom: 'auto', width: '100%', maxHeight: 'none', boxShadow: 'none', margin: '0 0 12px' }
        : styles.panel;

      const journal = (detail && detail.journal) || [];

      return h('div', { style: shell, role: inline ? undefined : 'dialog', 'aria-label': '智能体' },
        h('div', { style: styles.head },
          h('select', {
            style: styles.select,
            value: (data && data.boundAgentId) || '',
            onChange: (event) => bind(event.target.value || null),
          },
            h('option', { value: '' }, '（本窗口不绑定智能体）'),
            ...((data && data.agents) || []).map((agent) =>
              h('option', { key: agent.id, value: agent.id }, `${agent.name}（${agent.journalCount} 条日志）`)),
          ),
          h('button', { style: styles.ghost, onClick: () => fileRef.current && fileRef.current.click(), title: '从一段既有对话导入' }, '导入对话'),
          h('button', {
            style: styles.ghost,
            onClick: async () => {
              const created = await send({ action: 'create', name: window.prompt('新智能体名字', '新的她') || '未命名智能体' });
              if (created && created.created) await refresh();
            },
          }, '新建'),
          inline ? null : h('button', { style: styles.ghost, onClick: onClose }, '×'),
        ),
        h('input', { ref: fileRef, type: 'file', accept: '.json,.txt,.md', style: { display: 'none' }, onChange: importFile }),

        !data || !data.boundAgentId
          ? h('div', { style: styles.small },
              '把一个窗口绑定到某个智能体后，它的人设 + 累积记忆会注入该窗口的系统提示词；'
              + '该窗口之后每一轮的对话都会自动追加进它的日志。')
          : h('div', null,
              h('div', { style: styles.small },
                `本窗口注入 ${data.liveInjection} 字 · 日志 ${detail ? detail.journalCount : 0} 条 · 记忆 ${(memory || '').length} 字`,
              ),
              h('div', { style: styles.tab },
                ['persona', 'memory', 'journal'].map((key) =>
                  h('button', {
                    key, style: { ...styles.ghost, ...(tab === key ? { borderColor: token.brand, color: token.brand } : {}) },
                    onClick: () => setTab(key),
                  }, key === 'persona' ? '人设' : key === 'memory' ? '记忆' : `日志 ${journal.length}`)),
              ),
              h('div', { style: styles.label }, '名字'),
              h('input', {
                style: { ...styles.select, width: '100%', height: 28 },
                value: name, onChange: (event) => setName(event.target.value),
              }),
              tab === 'persona'
                ? h('div', null,
                    h('div', { style: styles.label }, '人设 / 规则（注入到系统提示词）'),
                    h('textarea', { style: styles.area, value: persona, onChange: (event) => setPersona(event.target.value) }),
                  )
                : tab === 'memory'
                  ? h('div', null,
                      h('div', { style: styles.label }, '累积记忆（注入；每轮日志会自动追加到下面这个文件之外，需要"完善"时把要点写进来）'),
                      h('textarea', { style: { ...styles.area, minHeight: 200 }, value: memory, onChange: (event) => setMemory(event.target.value) }),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                        h('button', {
                          style: styles.ghost,
                          onClick: async () => {
                            const note = window.prompt('追加一条记忆（会写进 memory.md）');
                            if (!note) return;
                            await send({ action: 'appendMemory', agentId: detail.id, text: note });
                            await refresh();
                          },
                        }, '追加一条记忆'),
                        h('button', {
                          style: styles.ghost,
                          onClick: async () => {
                            const tail = journal.slice(-40).map((row) => `${row.role === 'assistant' ? '她' : '我'}：${row.text}`).join('\n\n');
                            setMemory(`${memory.trimEnd()}\n\n## 截至 ${new Date().toISOString().slice(0, 10)}\n\n${tail}`.trimStart());
                          },
                        }, '把最近 40 条日志并入记忆'),
                      ),
                    )
                  : h('div', null,
                      journal.length === 0
                        ? h('div', { style: styles.small }, '还没有日志：绑定后在这个窗口聊几轮，消息会自动累积进来。')
                        : journal.slice().reverse().map((row, index) =>
                            h('div', { key: index, style: styles.logRow },
                              h('span', { style: { ...styles.small, marginRight: 6 } },
                                `${row.role === 'assistant' ? '她' : '我'} · ${new Date(row.t).toLocaleTimeString?.() || ''}`),
                              h('span', null, String(row.text).slice(0, 200)),
                            )),
                    ),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' } },
                h('button', { style: styles.ghost, onClick: save, disabled: tab === 'journal' }, '保存人设/记忆'),
                h('button', { style: styles.ghost, onClick: () => bind(detail.id) }, '刷新注入'),
                h('button', { style: { ...styles.ghost, color: '#ff8080' }, onClick: remove }, '删除智能体'),
              ),
            ),
        error ? h('div', { style: styles.error }, `接口出错：${error}`) : null,
        busy ? h('div', { style: styles.small }, '…') : null,
      );
    }

    function SettingsPage() { return h(Panel, { inline: true, onClose: () => {} }); }

    function VaultButton() {
      const [open, setOpen] = React.useState(false);
      return h(React.Fragment, null,
        h('button', {
          type: 'button', style: styles.button, title: '智能体（人设 + 累积记忆）',
          onClick: () => setOpen((value) => !value),
        }, '智能体'),
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
      );
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        appCtx = ctx;
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'agent-vault', order: 41, label: () => '智能体',
        }, VaultButton));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'agent-vault', order: 61, label: () => '智能体',
        }, SettingsPage));
      },
    };
  },
});
