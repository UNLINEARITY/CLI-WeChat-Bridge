# 通信架构

本文档介绍 CLI WeChat Bridge 四个主要适配器（Codex、Claude Code、OpenCode、Pi）的通信架构，解释各 CLI 原生提供的 API 支持，以及为什么它们对 `node-pty` 的依赖程度不同。

## 概述

项目的核心职责是将微信消息桥接到本地运行的 CLI 工具，同时把 CLI 的输出、审批请求和运行状态同步回微信。每个 CLI 工具提供的编程接口不同，因此 bridge 为每个 CLI 实现了独立的适配器：

| 适配器 | CLI 工具 | 通信协议 | PTY 依赖 |
|--------|----------|----------|----------|
| `CodexPtyAdapter` | Codex | WebSocket JSON-RPC | 不需要（Headless/Panel 模式） |
| `OpenCodeServerAdapter` | OpenCode | HTTP REST + SSE | 不需要 |
| `PiTuiAdapter` | Pi | 原生 TUI + extension TCP IPC | 不需要（继承真实终端） |
| `ClaudeCompanionAdapter` | Claude Code | PTY 写入 + Hook TCP 回调 | **需要** |

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        微信用户                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ iLink API (HTTPS)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   WeChat Transport                                │
│              (消息收发、上下文管理、轮询)                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ BridgeEvent
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Bridge Controller                               │
│           (路由、状态机、审批流、输出格式化)                          │
└───────┬──────────────┬──────────────┬──────────────┬───────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
   Codex Adapter  Claude Adapter  OpenCode Adapter  Pi Adapter
   WebSocket RPC  PTY + Hook TCP  HTTP + SSE        Extension TCP
        │              │              │              │
        ▼              ▼              ▼              ▼
   codex app-server   claude      opencode serve   pi 原生 TUI
```

<!-- PLACEHOLDER_SECTION_3 -->

## Codex 适配器（WebSocket JSON-RPC）

### CLI 原生支持

Codex CLI 内置 `app-server` 子命令，启动后在本地端口提供 WebSocket JSON-RPC 服务：

```bash
codex app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-file <path>
```

这是一个持久的双向通信通道，支持完整的会话管理、turn 控制和审批交互。

### 三种运行模式

适配器根据 `renderMode` 选择运行模式：

| 模式 | 说明 | PTY 使用 |
|------|------|----------|
| **Headless** | Bridge 作为后台 daemon 运行，无可见 UI | 不使用 |
| **Native Panel** | 启动原生 Codex TUI，用户可在本地终端交互 | 不使用 |
| **Embedded CLI** | 在 PTY 中嵌入 Codex CLI（传统模式） | 使用 |

Headless 和 Panel 模式（占绝大多数使用场景）完全通过 WebSocket RPC 通信，不依赖 node-pty。

### 通信流程

```
发送消息:
  Bridge → WebSocket: { method: "turn/start", params: { threadId, input: [{type:"text", text}] } }

接收输出 (WebSocket notifications):
  Server → Bridge: item/agentMessage/delta  (流式文本片段)
  Server → Bridge: item/completed          (单项完成)
  Server → Bridge: turn/completed          (整轮完成)

审批请求 (server-initiated requests):
  Server → Bridge: item/commandExecution/requestApproval
  Bridge → Server: { decision: "accept" | "decline" }
```

### 会话管理

- `thread/start` — 创建新会话线程
- `thread/resume` — 恢复已有会话
- `turn/interrupt` — 中断当前执行

<!-- PLACEHOLDER_SECTION_4 -->

## OpenCode 适配器（HTTP REST + SSE）

### CLI 原生支持

OpenCode CLI 内置 `serve` 子命令，启动后在本地端口提供 HTTP REST API 和 SSE 事件流：

```bash
opencode serve --port <port> --hostname 127.0.0.1
```

配套的 `@opencode-ai/sdk` npm 包提供了类型安全的 TypeScript 客户端。

### 通信流程

```
发送消息:
  Bridge → HTTP POST: session.promptAsync({ sessionID, parts: [{type:"text", text}] })

接收输出 (SSE 事件流，3 路并行):
  event stream:       message.part.delta    (流式文本片段)
  global-event:       session.idle          (turn 完成信号)
  global-sync:        session.status        (状态变更)

审批请求:
  SSE: permission.asked  →  Bridge 转发到微信
  用户回复后:
  Bridge → HTTP: permission.respond({ sessionID, permissionID, response: "once"|"reject" })
```

### 会话管理

- `session.create` — 创建新会话
- `session.list` — 列出当前目录的会话
- `session.abort` — 中断当前执行
- `tui.selectSession` — 同步本地 TUI 的可见会话

### 为什么不需要 PTY

OpenCode 的 server 模式提供了完整的结构化 API：输入通过 HTTP 发送，输出通过 SSE 接收，审批通过 HTTP 响应。整个通信链路不涉及终端模拟。

<!-- PLACEHOLDER_SECTION_5 -->

## Pi 适配器（原生 TUI + extension TCP IPC）

### CLI 原生支持

Pi 支持通过 CLI 参数加载 extension：

```bash
pi --approve --extension <bridge-extension>
```

`wechat-pi` 在可见 companion 进程中启动这条命令，并让 Pi 子进程直接继承 companion 的 stdin、stdout 和 stderr。用户看到和操作的因此是完整原生 Pi TUI，而不是 bridge 自己绘制的终端壳。它不需要 `node-pty`，因为这里没有模拟终端：Pi 直接使用启动窗口提供的真实 TTY。

### 通信流程

```
微信输入:
  Bridge → localhost TCP → extension → pi.sendUserMessage()

本地输入:
  用户键盘 → 原生 Pi TUI → extension input event → Bridge 镜像状态

最终回复:
  Pi message_end / agent_settled → extension → Bridge → 微信

会话控制:
  session_start 同步当前 session
  /stop → extension context.abort()
  /new / resume → extension command context.newSession() / switchSession()
```

微信 `/resume` 在 Codex、Claude Code、OpenCode 和 Pi 中使用同一套控制语义：首次调用列出当前工作目录最近 8 个根 thread/session，并保存 5 分钟的编号快照；随后可用编号、完整 ID 或唯一 ID 前缀恢复。编号解析位于共享 bridge 控制层，adapter 只接收经过解析的真实 ID。实际切换必须处于 idle 且没有待处理审批或用户输入；Codex 等待 app-server 预检与 visible supervisor 响应，Claude 等待 `SessionEnd(reason=resume)` 和目标 `SessionStart(source=resume)`，OpenCode 等待 `tui.selectSession` 与 route reporter，Pi 以 extension `switchSession()` 的响应和 session state 作为确认。

双向同步以可见 TUI 为最终事实来源。OpenCode companion 通过仅在本次进程生效的临时 TUI plugin 观察 `route.current`，并经带随机 token 的 localhost JSONL 通道报告可见 session；它不修改用户的永久 OpenCode 配置。Pi 直接复用 extension 的 `session_start` 状态。电脑端主动切换会使 resume 编号快照失效；若旧 session 中仍有微信任务，adapter 先中止并结算旧任务，再提交新的 shared session 和本地切换通知。

Codex headless runtime 持有持久 WebSocket app-server，bridge RPC 与可见 TUI 连接同一 endpoint。列表使用 `thread/list` 的 cwd、root source 和更新时间过滤；恢复先以 `thread/read` 排除跨 cwd、subagent、ephemeral 与 active 目标，再用纯 thread ID 执行 `thread/resume`。可见 `codex-remote-client` 作为 supervisor 在 adapter endpoint 登记随机 token 保护的 localhost 控制端口；收到切换请求后只替换 TUI 子进程，并以目标 `codex resume <thread-id> --remote ...` 稳定启动作为 acknowledgement。失败时 supervisor 尝试恢复旧可见 thread，bridge 也不会提前改变 shared thread。

Claude companion 不需要额外插件：交互式 `/resume` 会先触发旧 session 的 `SessionEnd(reason=resume)`，再为目标 transcript 触发 `SessionStart(source=resume)`。bridge 用 transcript 文件名校验目标 UUID，区分微信恢复、本地恢复与启动恢复。历史列表优先读取 `sessions-index.json`，缺失时只读取 JSONL 头尾的有界窗口；sidechain、跨 cwd 与仍在运行的 background session 均不接管。

可见 companion 托管唯一 Pi TUI 子进程，本地键盘和微信输入共享同一 session。微信 turn 与本地 turn 都会在 `agent_settled` 后生成微信 `final_reply`；本地输入先以 `mirrored_user_input` 标明来源，随后再转发对应的最终回答，因此电脑与微信可以观察同一条完整对话链路，同时避免把历史回放误认成新回答。

### 权限与交互

Pi 适配器不增加 bridge 工具审批层，文件与命令工具直接继承启动用户的本地权限。`--approve` 用于信任当前项目的 Pi 配置与资源。因为运行的是原生 TUI，Pi 自己的主题、快捷键、模型选择以及其他 extension 的交互式 UI 都会正常保留。

## Claude Code 适配器（PTY + Hook TCP）

### CLI 原生支持现状

Claude Code CLI **没有提供持久的 server/daemon 模式**。它的编程接口是：

- **交互式 CLI** — 标准的终端交互，支持 ANSI 渲染、方向键、全屏 TUI
- **Hook 系统** — 在 CLI 生命周期事件（权限请求、任务完成等）时执行外部脚本
- **`--print` 模式** — 单次对话，输出后退出（不支持持久会话）

与 Codex 的 `app-server` 和 OpenCode 的 `serve` 不同，Claude Code 没有暴露可以持续发送/接收消息的 API 端点。

### 通信流程

适配器使用两条通道协同工作：

**输入通道（PTY 写入）：**

```
Bridge → PTY stdin: \x1b[200~ <多行文本> \x1b[201~ \r
                    (bracketed paste 模式，避免被解释为多条命令)
```

**输出通道（Hook TCP 回调）：**

```
Claude CLI 执行 hook 脚本
  → hook.sh 设置环境变量 (PORT, TOKEN)
  → node claude-hook.ts 读取 stdin 获取 payload
  → TCP 连接到 Bridge 的 Hook Server (127.0.0.1:<port>)
  → 发送: { token, requestId, payload }
  → 等待响应: { requestId, stdout }
  → 将 stdout 写回自身 stdout（Claude CLI 读取作为 hook 输出）
```

**补充通道（Transcript 轮询）：**

```
Bridge 每 800ms 读取 Claude 的 JSONL transcript 文件增量
  → 解析 assistant 消息中的 "thinking" content blocks
  → 转发思考内容到微信
```

### Hook 事件类型

适配器注册了以下 Claude Code hook 事件：

| Hook 事件 | 用途 |
|-----------|------|
| `SessionStart` | 获取 session ID 和 transcript 路径 |
| `UserPromptSubmit` | 检测本地终端输入（区分微信/本地来源） |
| `PermissionRequest` | 权限审批（核心交互） |
| `Notification` (permission_prompt) | 自动审批失败时的回退 |
| `Stop` | turn 完成，提取最终回复文本 |
| `StopFailure` | turn 失败 |
| `PreCompact` / `PostCompact` | 上下文压缩事件 |

### 审批机制

```
1. Claude CLI 需要权限 → 触发 PermissionRequest hook
2. hook 脚本 TCP 连接到 Bridge，发送审批请求
3. Bridge 检查自动审批规则：
   - 非 Bash 工具 → 自动放行
   - 低风险 Bash 命令 → 自动放行
   - 高风险操作 → 转发到微信等待用户决策
4. TCP socket 保持打开，等待用户回复
5. 用户 /confirm 或 /deny → Bridge 写回决策到 socket：
   { "hookSpecificOutput": { "decision": { "behavior": "allow" } } }
6. hook 脚本将决策输出到 stdout → Claude CLI 读取并继续/中止
```

### 为什么需要 PTY

1. **输入注入**：Claude Code 没有 API 接收消息，只能通过终端 stdin 输入。PTY 让子进程认为自己运行在真实终端中，正确处理 bracketed paste、ANSI 序列等。
2. **Hook 系统依赖交互式会话**：Hook 在持久的交互式进程中触发，`--print` 模式下 hook 行为不同。
3. **会话持久性**：交互式模式支持 `--resume`/`--continue`，保持上下文连续。`--print` 每次都是独立调用。

### `--print` 模式的局限

Claude Code 确实提供了 `--print --output-format stream-json --input-format stream-json` 模式，但它是**单次对话**设计：

- 每次调用处理一个 prompt 后退出
- 不支持在同一进程内进行多轮交互
- 审批交互需要通过 `--permission-mode` 预设，无法动态转发到微信
- 会话恢复需要每次重新启动进程（`--resume <id>`）
- Hook 系统在 `--print` 模式下的行为与交互模式不完全一致

### 回退模式（TERM=dumb）的问题

当 node-pty 不可用时，适配器回退到 `child_process.spawn` + `TERM=dumb`。此模式下：

- Claude CLI 检测到非 TTY 环境，可能切换到非交互行为
- Bracketed paste 不被支持，多行输入可能被错误解析
- Hook 系统本身仍然工作（通过 `--settings` 注册），但 CLI 的输入/输出行为可能不符合预期

<!-- PLACEHOLDER_SECTION_6 -->

## 对比总结

| 维度 | Codex | OpenCode | Pi | Claude Code |
|------|-------|----------|----|-------------|
| **CLI 原生 API** | `app-server` (WebSocket RPC) | `serve` (HTTP + SSE) | Extension API | 无持久 API |
| **通信协议** | WebSocket JSON-RPC | HTTP REST + SSE | 原生 TUI + localhost TCP JSONL | PTY stdin + Hook TCP |
| **PTY 依赖** | 不需要（Headless/Panel） | 不需要 | 不需要 | **需要** |
| **输入方式** | `turn/start` RPC 调用 | `session.promptAsync` HTTP | `pi.sendUserMessage()` | PTY 写入 (bracketed paste) |
| **输出方式** | WebSocket notifications | SSE 事件流 | `message_end` / `agent_settled` extension events | Hook 回调 + transcript 轮询 |
| **审批机制** | Server-initiated RPC request | SSE event + HTTP respond | 无 bridge 工具审批层 | Hook TCP socket 保持 |
| **会话管理** | `thread/start` / `thread/resume` | `session.create` / SDK | `newSession()` / `switchSession()` | `--resume` CLI 参数 |
| **中断** | `turn/interrupt` RPC | `session.abort` HTTP | extension context `abort()` | PTY 写入 Ctrl+C (`\x03`) |
| **node-pty 不可用时** | 正常工作 | 正常工作 | 正常工作 | 可能无法正常桥接 |

## 未来方向

### Claude Code Server 模式

如果 Claude Code 未来提供类似 Codex `app-server` 的持久 RPC 接口，本项目可以实现无 PTY 的 Claude 适配器，彻底消除原生模块依赖问题。

### `--print` + stream-json 的潜在利用

理论上可以通过以下方式实现无 PTY 的 Claude 桥接：

1. 每轮对话启动 `claude --print --output-format stream-json --input-format stream-json --resume <id>`
2. 通过 stdin 发送用户消息
3. 从 stdout 读取流式 JSON 输出
4. 进程退出后，下一轮用 `--resume` 恢复会话

但这种方案存在以下挑战：
- 每轮都要重新启动进程（冷启动开销）
- 审批交互需要预设 `--permission-mode`，无法动态转发到微信
- Hook 系统在 `--print` 模式下的行为需要验证
- 会话状态的连续性依赖 `--resume` 的可靠性

### Remote Control 模式

Claude Code 近期新增了 `--remote-control` 选项，可能提供了一种新的编程接口。这是一个值得探索的方向，可能允许外部程序通过结构化协议控制 Claude Code 会话。

---

*本文档基于当前源码撰写。随着上游 CLI 工具的演进，通信架构可能会调整。*
