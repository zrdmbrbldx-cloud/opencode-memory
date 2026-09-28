# opencode-memory

给 OpenCode v2 加上**跨会话记忆**——它默认只有 `AGENTS.md`（静态指令）和会话历史，
会话之间不共享任何积累。

这个插件模仿一个长期助理做笔记的方式，分三层：

| 层 | 机制 | 作用 |
|---|---|---|
| **召回** | `session.hook("context")` | 每次模型请求前，把相关记忆注入系统提示 |
| **写入** | `memory_write` / `memory_search` / `memory_read` 工具 | agent 自己决定记什么、查什么 |
| **人用** | `/remember`、`/memory` 命令 | 你随时让它记一条，或看看记了什么 |

---

## 安装位置

```
<OpenCode 配置目录>/plugins/memory/index.js
```

放在**全局配置目录**的 `plugins/` 下会被自动发现，所有项目都能用。

不确定配置目录在哪，执行：

```bash
opencode debug paths     # 看 config 那一行
```

装好后执行一次 `opencode service restart` 让它加载。

---

## 记忆存放在哪

全部是纯 Markdown，可以直接用编辑器看、用 grep 搜：

```
<配置目录>/memory/
├── config.json                          ← 可调参数（见下）
├── .status.json                         ← 自检：插件是否加载、注册了什么
├── user/MEMORY.md                       ← 跨项目：你的偏好、习惯
└── projects/
    └── <项目 slug>/                      ← 按项目隔离（slug 由项目路径生成）
        ├── .project                     ← 记录原始路径，方便辨认
        ├── MEMORY.md                    ← 项目长期记忆（精炼、稳定）
        └── log/
            └── 2026-09-24.md            ← 每日工作日志（追加式流水）
```

放在配置目录而不是项目里，是为了**不污染你的仓库**。
如果更希望记忆跟着项目走，把 `config.json` 的 `storage` 改成 `"project"`，
它会写到 `<项目>/.opencode/memory/`（记得加 `.gitignore`）。

---

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `memory_write` | `target`: `log` \| `project` \| `user`<br>`content`: Markdown<br>`mode`: `append`（默认）\| `replace` | `log` 追加到当天日志；`project` / `user` 追加到长期记忆 |
| `memory_search` | `query`, `limit?` | 在所有记忆文件里检索，返回 `文件:行号: 内容` |
| `memory_read` | `target`: `index` \| `user` \| `project` \| `log`<br>`date?` | 读某个记忆文件；不带参数则列出记忆索引 |

插件会在系统提示里注入使用规则，所以 agent 会在完成实质性工作后主动记录，
需要历史信息时主动检索。

## 命令

- `/remember <内容>` —— 交给 agent 判断该写日志还是写长期记忆
- `/memory` —— 让它汇报当前记忆索引与项目记忆

---

## 配置

编辑 `<配置目录>/memory/config.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `storage` | `"config"` | `"config"` 存配置目录；`"project"` 存项目内 `.opencode/memory/` |
| `injectUserMemory` | `true` | 是否注入用户级记忆 |
| `injectProjectMemory` | `true` | 是否注入项目长期记忆 |
| `injectRecentLog` | `true` | 是否注入最近日志 |
| `recentLogDays` | `1` | 注入最近几天的日志 |
| `maxMemoryChars` | `4000` | 单个记忆文件注入上限（超出截断） |
| `maxLogChars` | `3000` | 单天日志注入上限 |
| `maxInjectChars` | `12000` | 注入总量上限 |
| `autoCapture` | `false` | **自动记录**：会话结束后自动提炼几条事实写入当天日志 |
| `autoCaptureMinToolCalls` | `4` | 自动记录的门槛：至少这么多次工具调用才算"实质性工作" |

### 关于自动记录

默认**关闭**。打开后（`"autoCapture": true`），每次会话成功结束且工具调用次数达标时，
插件会额外调一次模型，把这次会话里值得长期记住的事实提炼成 1–3 条，追加到当天日志。

- 好处：不依赖 agent 自觉，记忆一定会积累
- 代价：每次达标会话多一次模型调用（用的是你的默认模型）
- 注意：它只写**日志**（追加流水），不会动精炼的 `MEMORY.md`，所以噪音可控

---

## 卸载

删掉 `plugins/memory/` 目录，然后 `opencode service restart`。
记忆文件（`memory/` 目录）会保留，想彻底清掉就一并删除。

---

## 实现笔记（踩过的坑）

写这个插件时踩到两个坑，记录下来免得重犯：

### 1. 不要 `import { Plugin } from "@opencode/plugin"`

本地插件目录在 CLI 的模块解析范围之外，这个 import 会直接失败：

```
failed to load plugin  cause="Cannot find package '@opencode/plugin'"
```

正解是导出**普通对象**——`export default { id, async setup(ctx) { ... } }`。
`Plugin.define()` 只是给 TypeScript 用的类型辅助，运行时不需要。

### 2. ⚠️ 工具名必须全局唯一，否则会覆盖内置工具

`editor.namespace()` 在 2.0.15 上**不会给 id 加前缀**。如果把工具命名为
`write` / `read` / `search`，它会**直接覆盖 OpenCode 内置的文件读写工具**，
导致 agent 再也无法读写文件。

本插件第一版就踩了这个坑，实测确认后改名为 `memory_write` / `memory_search` /
`memory_read`，并回归验证内置 `read` / `write` 恢复正常。

**结论：注册工具时永远用带明确前缀的名字，不要依赖 namespace。**

---

## 已实测验证

| 项目 | 结果 |
|---|---|
| 插件加载 | `plugins/memory` 被自动发现并加载，无报错 |
| 系统提示注入 | 注入魔法词后模型准确复述，证明 `context` 钩子生效 |
| 工具注册 | `memory_write` / `memory_search` / `memory_read` 均注册成功 |
| 工具可调用 | agent 能正确调用并返回结果 |
| **跨会话召回** | 写入后**开全新会话**询问，正确答出 `2026-09-24` |
| 记忆检索 | `memory_search "召回"` 命中并返回 `文件:行号: 内容` |
| 命令注册 | `remember`、`memory` 均在 `ctx.command.list()` 中 |
| 配置读取 | 改 `config.json` 后重启，`autoCapture` / `recentLogDays` 生效 |
| 内置工具回归 | 命名冲突修复后，agent 能正常创建文件并读回内容 |
| 自检 | `.status.json` 记录加载时间、注册的工具/命令/钩子 |
