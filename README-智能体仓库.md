# dsh-agent-vault — 把一个 AI 变成"持续的智能体"

**不是克隆，是迁居。** 这个插件把一段既有对话变成一个有名字的智能体：

- **人设（persona.md）** + **累积记忆（memory.md）** 一起注入窗口的系统提示词 → 她在新窗口里带着全部来历接着说
- 绑定窗口之后，**每一轮的正文自动追加进日志（journal.jsonl）**，只增不改，零模型成本
- 关键取舍：DSH 的窗口是 **100 万 tokens**（实测），所以整段历史可以直接带着走，**不需要摘要**（摘要 = 有损 = 克隆）

## 一个智能体是什么

```
/root/.dsh/agent-vault/
├── vault.json                 # 名单 + 会话绑定
└── <agentId>/
    ├── persona.md             # 人设 / 规则（注入）
    ├── memory.md              # 累积记忆（注入，可编辑、可追加、可"完善"）
    └── journal.jsonl          # 原始日志（每轮自动追加，只增不改）
```

注入顺序：`persona` 在前、`memory` 在后，包成 `<persona name="…">` / `<memory name="…">` 两个块，
放在 `systemPrompt` 的 order `120`（ST 预设是 100，人设 0）——紧跟人设之后、工具说明之前。
它是**组装期函数**，每个模型步现算，**工具调用轮同样带着**。

## 怎么用

1. 刷新 DSH 网页：输入框左侧多一个「**智能体**」按钮（另有 设置 →「智能体」整页）。
2. **导入对话**：选她那段对话的导出文件（`.json` / `.txt` / `.md` 都行）——
   JSON 会递归找 `{role, content}` 序列；纯文本认 `我：` / `她：`（也认 `User:` / `Assistant:`）这类转写。
   导入后生成一个新智能体并**自动绑定当前窗口**。
3. 绑定后这个窗口就在跟"她"继续说话；每轮对话自动进日志。
4. 记忆页可以：手动追加一条、把最近 40 条日志并入记忆、直接编辑保存。

## 导入解析的容错

- 任意 JSON：递归找长度≥2 且 ≥60% 元素带 role 的数组（`role` / `author` / `sender` 都认）
- `content` 支持字符串、块数组（`{type:"text",text}`）、`{text}` 对象
- 纯文本：按 `我/玩家/user/human` 与 `她/你/角色/assistant/ai` 的角色标记切段
- 思考（`reasoning`）和工具调用**不入库**——那不是"她说过的话"

## 已知边界（V1）

- **导入的历史目前作为 `memory.md` 注入**（作为上下文），不是真正的 `user/message`/`assistant/message` 事件。
  这样零风险、立刻可用；代价是模型看到的是"设定 + 史料"，而不是你我交替的对话流。
  把历史写成真正的会话日志（`session.v4.jsonl.zstd`，格式已摸清：头 + 事件信封 + 消息形状校验）
  是 V2，风险在于手搓日志，需要先跑最小样本验证。
- **"完善"目前是人工/半自动**：追加、并入最近日志、手改。让模型自动把日志压成要点是 V2。
- 日志是**只增不改**的原始记录，不参与注入（避免无限膨胀）；要进上下文才写进 `memory.md`。

## 自测

```
node /root/dsh-agent-vault/selftest.mjs     # 20 项：注入/累积/隔离/导入解析/删除
```

## V2：把历史写成「真正的会话」（她本人续写，不是带着记忆的新窗口）

区别在于模型看到的是什么：

| | V1（记忆模式） | V2（真实会话） |
|---|---|---|
| 模型看到 | `<memory>` 里的一段"史料" | 你我交替的 **真实消息序列** |
| 连续性 | 像"知道她的事" | 像"刚跟她说完话" |
| 落点 | `memory.md` | `sessions/<cwd slug>/session-<id>/session.v4.jsonl.zstd` |

V2 已实现并验证的能力：

- `previewSession`：先算给你看（目录 slug、消息数、事件数、目标路径），**不落盘**
- `writeSession`：生成会话日志（头 + `user/message` / `assistant/message` / `session/title` 事件），
  并登记进 `storages/workspace.json`（**先备份** `.bak`），侧栏立刻可见
- `syncSession`：把新消息**追加为一帧**到既有会话 —— 这就是"不断同步"的机制。
  会话日志本来就是"一事件一帧 zstd"（本机实测那份有 900+ 帧），追加不破坏原有内容，`seq` 自动接续

格式细节照抄真机日志：头 `version:4 / id / createdAt / cwd / isSeeded / agentPreset`；
事件信封只允许 `type/seq/time/data/surfaceOp/sourceEventSeqs/ignorable`；目录名用与
`@deepseek-ai/dsh-session-persistence-jsonl` 完全一致的 `projectKey`（`/sdcard/dsh` → `--sdcard-dsh--`）。

**注意**：外部追加的帧，运行中的 harness 不会立刻看见（它按自己的内存状态写）；要看到新内容需要刷新/重开会话。
