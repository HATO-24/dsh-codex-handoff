# dsh-codex-handoff — GPT / Codex 对话桥（DSH 插件）

把本机 Codex CLI（GPT）接进 DeepSeek Harness：**每一轮往来都能在 DSH 侧栏点开查看**，会话落进 Codex 会话库，
并且可以用一个工具让 GPT 作为 DSH 的子代理被调用、按同一个 thread 多轮续接。

---

## 安装

需要 DSH（DeepSeek Harness）与**本机已登录、可正常调用的 Codex CLI**（`codex` 可执行文件会自动在
`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`、`CODEX_BIN`、PATH 里找）。

### 从 npm（推荐）

```
dsh-codex-handoff@0.1.1
```

- 界面：**插件** 页 → 添加 → 输入 `dsh-codex-handoff`
- 工具：`plugin_manager` → `install_bundle`，`target` 填 `dsh-codex-handoff@0.1.1`

### 从源码

```powershell
git clone https://github.com/HATO-24/dsh-codex-handoff.git
```

然后在 DSH 里装进当前 profile：界面里 **插件** 页 → 添加 → 指向克隆下来的目录，
或用 `plugin_manager` → `install_bundle`，`target` 填该目录的绝对路径。

装好后：

- 左侧栏面板列表多出 **GPT 对话**（点开在中间整页查看）
- 会话标题栏最右侧多一个对话气泡按钮（点开是右侧抽屉）

> 本地改代码后，在插件页把该插件 **禁用 → 启用** 即可重载新代码，不用重启 DSH。
> 首次调用会消耗 Codex 额度；想省上下文就把 `DSH_CODEX_BRIDGE_ISOLATE=1` 打开。

---

## 一、先说清楚：GPT 到底能看到什么

这是本插件最初要回答的问题，结论来自实测，不是推测。

### 实测方法（零额度）

```powershell
# 让 Codex 把「模型实际收到的输入」原样打印出来，不调用模型、不扣额度
codex debug prompt-input "test"
```

输出是一个 7 条的 JSON 数组。逐条看，模型看到的东西远超「桥发过去的那一段 prompt」：

| 注入项 | 实测证据 | 大小/内容 |
| --- | --- | --- |
| **你的全局人设指令** | developer message 第 1 条 | `~/.codex/config.toml` 里 `model_instructions_file` 指向的 `prompts/gpt-with-taste/main.md`，**24,461 字符**，含「Be lively, perceptive, warm, and opinionated…」整套性格与工作方式。 |
| **skills 清单** | developer message 第 2 条 `<skills_instructions>` | 4,897 字符。列出 skill roots：`~/.codex/skills/.system`、`plugins/cache/openai-bundled`、`plugins/cache/openai-primary-runtime`、`.../spreadsheets/.../skills`，以及 imagegen 等可用 skill。**GPT 看到路径就能自己读 SKILL.md。** |
| **MCP 工具** | 工具表 | `mcp__cua_repl.js`、`mcp__cua_repl.js_reset` —— 来自 `config.toml` 的 `[mcp_servers.node_repl]`（浏览器/计算机控制）。 |
| **插件推荐列表** | developer message `<recommended_plugins>` | 876 字符，列出 Dropbox / GitHub / Gmail / Slack / Notion 等 16 个「可用未安装」插件。 |
| **多代理系统提示** | developer message `<multi_agent_role>` / `<multi_agent_mode>` | 2,400 + 271 字符，含 `spawn_agent` / `followup_task` 的协作规则。 |
| **环境上下文** | user message `<environment_context>` | cwd、shell、日期、时区、文件系统权限根（含 `.git`、`.agents`、`.codex`、`.aws` 可读条目）。 |
| **Codex 记忆** | `config.toml` `[features] memories = true` / `[memories] use_memories = true` | 会读取 `memories_1.sqlite` / `memories_v2_1.sqlite` 里积累的记忆。 |

**一句话结论：会。** 而且不止 skills —— 你的 24KB 人设、MCP 工具、插件推荐、多代理提示、环境路径、记忆库，全都在模型的上下文里。
桥的 `-Action ask` 只负责发一段 prompt，**其余全是 Codex 自己加载的**。

### 想隔离

三档，从彻底到精确：

```powershell
# 1) 完全隔离：不加载 ~/.codex/config.toml（auth 仍用 CODEX_HOME）
codex exec --ignore-user-config -m gpt-6-sol ...

# 2) 只关插件推荐（实测有效）
codex exec --disable plugins ...

# 3) 只关 MCP
codex exec -c 'mcp_servers={}' ...
```

本插件与升级后的 `gpt_bridge.ps1` 都提供 `-Isolate` / `DSH_CODEX_BRIDGE_ISOLATE=1` 开关，
**默认关闭**（沿用你现有配置，保留 gpt-with-taste 人设与 Codex 能力），需要干净上下文时手动打开。

> 注意：`--ignore-user-config` 同时会丢掉 `model` 等配置，隔离时要显式传 `-m`。

---

## 二、装了什么

| 组件 | 作用 |
| --- | --- |
| Host 半边 `lib/index.js` | 调 `codex exec`、维护 `.bridge` 存储、提供 `/api/codex-bridge/*` 路由、注册 `codex_gpt` 工具 |
| Client 半边 `lib/client.js` | 侧栏「GPT 对话」入口 + 主面板（会话列表、逐轮提问/回复） |
| `gpt_bridge.ps1`（升级版） | 命令行桥，默认持久化会话、记录 thread_id、支持 `-Resume` |

装在 DSH profile 里（`plugin_manager` 本地目录安装），重启后仍在。

---

## 三、用

### 1. 侧栏查看记录

两个入口，同一份数据：

- **侧栏面板**：DSH 左侧栏面板图标里多一个 **GPT 对话**（order 30，在「写作助手」之后、「ZAI Usage」之前），点开在中间整页查看。
- **右侧抽屉**：会话标题栏最右侧（`…` 左边）多一个对话气泡按钮，点开从右边滑出 430px 抽屉，**贴着对话看不打断主界面**；`Esc` 或右上角 × 关闭。抽屉从标题栏下方（`top: 48px`）开始——窗口控制按钮（− □ ×）在页面之上，任何 z-index 都盖不过去，只能避开。

两个入口都显示每段会话的**模型与推理强度**：

- 卡片行：`11-06 03:04 · 1 轮 · 推理 low · #01a1ad`
- 头部副标题：`Codex 桥 · 5 段会话 · 模型 Codex 默认 / 推理默认`（来自 `/list` 的 `defaults`）
- 详情里每一轮还带该轮的 `model` / `推理 x`，以及 `Nk in` 输入 token（悬停可看 cached）
- 老记录同样显示：`model` / `reasoning` 从当年 ps1 写的 `inbox/<id>.json` 里读出来

数据来自 `<workspace>/.bridge/`，与 `gpt_bridge.ps1` 共用同一套目录，所以**老记录也能看到**：

- 新格式：`.bridge/conversations.json` 索引 + `outbox/<id>.prompt.md` + `inbox/<id>.reply.md`
- 老格式：直接扫 `outbox/*.prompt.md`，thread_id 从 `inbox/<id>.json` 或 `logs/<id>.stdout.jsonl` 里回捞

实测：升级前的 3 条老记录全部列出，其中 2 条成功恢复了 Codex thread_id（另 1 条是模板没写回复的空记录）。

### 1.5 在面板里直接发消息、切换模型

侧栏面板和右侧抽屉底部都有发送区：

- 输入框：`Enter` 发送、`Shift+Enter` 换行
- **模型下拉**：来自 `/models`，列出 `codex debug models` 里的全部 10 个模型
  （`GPT-6.1-Sol` / `GPT-6-Astra` / `GPT-6.1 Terra` / `GPT-6-Sol` / …）
- **推理下拉**：跟着所选模型的支持档位走（`low/medium/high/xhigh/max/ultra`）
- **会话级记忆**：选中某段会话时，两个下拉会自动回填该会话上次用的模型与推理强度；
  之后直接发送就沿用它，不用每次重选。切换会话才重置，列表自动刷新不会覆盖你当下的选择。
- **选中某段会话时发送 = 续接那个 Codex 会话**；没选中 = 新开一段
- 发送完会自动选中新会话并刷新列表

> 下拉是插件自绘的（`Dropdown` 组件），不是原生 `<select>`：原生弹层由系统绘制，
> 在 Windows 深色模式下会变成白底，且不受 DSH 主题 token 控制，截图也截不到。
> 自绘版用 `--dsw-alias-*` token，明暗主题切换会跟着变。

**记录的是「实际用了什么」，不是「你传了什么」**：每轮结束后插件会去 rollout 的
`turn_context` 里读真实的 `model` 与 `effort`，写进 `inbox/<id>.json` 的
`actualModel` / `actualEffort`；不传模型时也不会再显示空值。

**实测**（`model=gpt-6.1-sol, reasoning=high`）：

| 来源 | model | effort |
|---|---|---|
| 请求参数 | gpt-6.1-sol | high |
| 桥记录 `actualModel` | gpt-6.1-sol | high |
| rollout `turn_context` | gpt-6.1-sol | high |

卡片上因此能区分 `gpt-6.1-sol` 与 `gpt-6-sol`——这两个确实是不同的模型，
`gpt-6-sol` 的默认推理是 medium、`gpt-6.1-sol` 是 low。

### 2. 让 GPT 当子代理（多轮续接）

DSH agent 会看到新工具 `codex_gpt`：

```
codex_gpt({ message: "审查 docs/plan.md 的里程碑，找不可执行之处", reasoning: "high" })
→ { conversationId: "c-...", threadId: "01a1...", reply: "..." }

# 第二轮：同一个 conversationId 即续接同一个 Codex 会话，不用重发上下文
codex_gpt({ conversationId: "c-...", message: "第 2 点展开，给具体改法" })

# 也可以直接续接任意 Codex thread（例如侧栏老记录上的那个）
codex_gpt({ threadId: "01a1ac8e-01a4-79a2-a70d-855254e70751", message: "继续上次的方案" })
```

参数：`message`（必填）、`conversationId` / `threadId`（二选一）、`model`、`reasoning`。

> **模型与 reasoning 的坑**：`codex debug models` 里有 **10 个模型**，`gpt-6-sol` 和 `gpt-6.1-sol`
> 是**两个不同的模型**（前者 default 推理 medium，后者 low）。推理档位统一是
> `low / medium / high / xhigh / max / ultra`，**没有 `minimal`、也没有 `none`**——旧脚本的
> "minimal"默认值本身就是错的，传了会 `turn.failed`。
>
> `codex_gpt` 的 `model` / `reasoning` 不传就用 Codex 配置默认；传了会走 `-m` 与
> `-c model_reasoning_effort=…`，实测生效（见下）。

### 2.5 HTTP 接口（给脚本 / 外部调用）

路由前缀 `/api/codex-bridge`，同一个端口（默认 `http://127.0.0.1:12530`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/list` | 会话列表（含老记录）+ 当前默认配置 |
| GET | `/read?id=<id>` | 某段会话的逐轮提问与回复 + Codex 侧原文 |
| GET | `/status` | 工作区、codex 路径、隔离开关 |
| GET | `/models` | 可用模型目录（slug / 显示名 / 支持的推理档位） |
| POST | `/send` | 发一轮真实对话，body：`{message, conversationId?, threadId?, model?, reasoning?}` |

```powershell
$body = @{ message = "只回复两个字：收到"; reasoning = "low" } | ConvertTo-Json -Compress
Invoke-WebRequest -Uri "http://127.0.0.1:12530/api/codex-bridge/send" -Method POST `
  -Body $body -ContentType "application/json" -UseBasicParsing -TimeoutSec 900
# → {"conversationId":"c-...","threadId":"01a1...","reply":"收到"}
```

> `POST /send` 会**真实消耗 Codex 额度**，且同步等待（一次 `low` 推理实测约 58 秒）。
> 路由用 Node 原生 handler 而非 `resource`：`resource` 路由只放行 GET/HEAD，POST 会被平台层直接 405。

### 3. 在 Codex 软件里做第二轮

会话**默认持久化**（不再 `--ephemeral`），所以：

- 桥发起的对话会出现在 `~/.codex/sessions/` 并注册进 Codex 的 state DB；
- 在 Codex 桌面应用的会话列表里可以直接找到、继续；
- 命令行也能续：`codex exec resume <thread_id> -`。

### 4. Codex 侧回读（两边都能继续）

Codex 把每条持久化会话的完整时间线写在：

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时间>-<threadId>.jsonl
```

插件会按 `threadId` 找到对应 rollout，把里面的 `user` / `assistant` 原文抽出来，作为
**「Codex 会话原文」** 附在会话详情底部，并标出哪些是**只在 Codex 侧出现过**的轮次。

- 默认折叠显示最后 3 条，点「展开全部」看完整时间线（最多 60 条）
- 外部轮次的标签用主题强调色显示 `GPT · Codex 侧新增`
- `developer` 注入（人设、Memory、多代理规则）和 `<environment_context>` 会被过滤掉，只留真实问答

**实测**：桥自己只记了 1 轮，但在命令行另起一次 `codex exec resume` 之后，抽屉里读出了 4 条，
第 4 条 assistant 被正确标成「Codex 侧新增」。

> 限制：这条只对**持久化**的会话有效。早期跑 `--ephemeral` 的记录没有 rollout 文件，
> 所以只能看到桥自己存的那一轮——这是当初 `--ephemeral` 的代价，无法事后补回。

---

## 四、配置（环境变量）

在 DSH 进程环境里设置（或改 `lib/index.js` 顶部常量）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_CODEX_BRIDGE_WORKSPACE` | 自动探测 | 工作区根。默认优先选「已有 `.bridge` 的 workspace」→ 注册表第一个 workspace |
| `DSH_CODEX_BRIDGE_CODEX` | 自动探测 | `codex.exe` 路径；回落 `CODEX_BIN` → `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` → PATH |
| `DSH_CODEX_BRIDGE_MODEL` | Codex 默认 | 模型，例如 `gpt-6-sol` |
| `DSH_CODEX_BRIDGE_REASONING` | Codex 默认 | `minimal` / `low` / `medium` / `high` |
| `DSH_CODEX_BRIDGE_TIMEOUT_SEC` | `900` | 单轮超时 |
| `DSH_CODEX_BRIDGE_ISOLATE` | `0` | `1` = `--ignore-user-config`，GPT 看不到你的 skills / MCP / 人设 / 记忆 |

---

## 五、额度与代价

- 每次 `codex_gpt` 都是真实模型调用，**消耗 Codex/GPT 额度**。
- 因为默认沿用你的 Codex 配置，**每一轮输入都带着那 24KB 人设 + skills 清单 + MCP 工具定义**，
  首次调用的 input token 会明显偏大（缓存命中后后续便宜）。
- 想要小上下文：开 `DSH_CODEX_BRIDGE_ISOLATE=1`，或用 `reasoning: "low"`。
- 额度紧张时仍可用命令行桥的排队能力：`gpt_bridge.ps1 -Queue` → 额度恢复后 `-Action flush`。

---

## 六、数据位置

```
<workspace>/.bridge/
  conversations.json          会话索引（本插件写）
  threads.json                命令行桥的 thread 台账（gpt_bridge.ps1 写）
  outbox/<id>.prompt.md       每一轮的提问
  inbox/<id>.reply.md         每一轮的回复
  inbox/<id>.json             元数据（含 thread_id、usage）
  logs/<id>.stdout.jsonl      codex --json 事件流（thread_id 也在这里）
  logs/<id>.stderr.log
```

`.bridge/` 已在主仓 `.gitignore` 里。

---

## 七、已知限制

- 侧栏是 DSH 的**左侧面板图标 + 主面板**（DSH 右侧栏的 tab 是内置闭环，插件无法往里追加 tab；
  `rightbar` 是 single slot，注册它会替换掉内置内容）。视觉上不在右列，但入口与内容完整。
- 面板只读：发起对话走 `codex_gpt` 工具或 `gpt_bridge.ps1`，面板负责查看。
- 老记录每条按单轮会话展示（当时没有会话索引，无法还原分组）。
- `codex exec resume` 不接受 `-C` / `-s` / `--color`，续接时 cwd 由进程工作目录决定、沙箱沿用原会话。
