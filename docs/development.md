# 开发说明

本文记录源码运行、测试、构建、全局安装验证和主要源码入口。安装和日常使用说明见 README。

## 环境准备

需要：

- [Node.js](https://nodejs.org/en/download) `>= 22.13.0`
- [Bun](https://bun.sh/docs/installation) `>= 1.0.0`
- 至少一个本地 CLI：Codex、Claude Code、OpenCode 或 Pi
- 至少一个远程通道凭据：微信登录凭据或企业微信 Bot 凭据

克隆并安装依赖：

```bash
git clone https://github.com/UNLINEARITY/CLI-WeChat-Bridge
cd CLI-WeChat-Bridge
bun install
```

源码模式依赖 Node 22.13 的 TypeScript strip-types 能力；发布包仍然需要先构建 `dist/*.js`。

## 源码模式命令

| 场景 | 命令 |
| --- | --- |
| 微信登录初始化 | `npm run setup` |
| 企业微信配对初始化 | `node --no-warnings --experimental-strip-types src/channels/wecom/setup-cli.ts` |
| 启动 daemon | `npm run daemon` |
| 启动企业微信 daemon | `npm run daemon -- --channel wecom` |
| Codex companion | `npm run codex:panel` |
| Codex 单命令启动器 | `npm run codex:start` |
| Claude companion | `npm run claude:companion` |
| Claude 单命令启动器 | `npm run claude:start` |
| OpenCode companion | `npm run opencode:panel` |
| OpenCode 单命令启动器 | `npm run opencode:start` |
| Pi companion | `npm run pi:companion` |
| Pi 单命令启动器 | `npm run pi:start` |

如果需要额外参数，可以追加在脚本后。例如：

```bash
npm run daemon -- --adapter codex
npm run daemon -- --channel wecom --adapter claude
npm run claude:start -- --cwd D:\work\my-project
npm run opencode:start -- --cwd D:\work\my-project
npm run pi:start -- --cwd D:\work\my-project --model openai/gpt-5.6-sol
```

源码模式的企业微信直接启动器使用同一个入口，并显式传入通道：

```bash
node --no-warnings --experimental-strip-types src/companion/local-companion-start.ts --channel wecom --adapter claude
```

`*:start` 是直接启动器的源码镜像：在当前终端运行 CLI，加入运行中的 daemon，没有时拉起临时 daemon。`*:companion` 与 `*:panel` 是维护者调试入口。普通用户应直接运行 `wechat-*`、`wecom-*` 或对应的 daemon 命令。

## Pi 原生 TUI 接管说明

Pi companion 启动一个长期运行的 `pi --approve --extension <bridge-extension>` 子进程，并使用 `stdio: "inherit"` 把当前可见终端直接交给 Pi。本地键盘和微信/企业微信输入共享这一原生 TUI 进程及其当前 session；远程输入由 extension 调用 `pi.sendUserMessage()`，`/stop` 调用 extension context 的 `abort()`，`/new` 和 `/new-session` 通过 command context 新建 session。

adapter 与 extension 之间只通过 localhost TCP JSONL 同步命令、session 状态和最终回复；Pi 的终端输出不经过该协议，因此主题、快捷键、模型选择和 extension UI 都保持原生行为，也不需要 `node-pty`。该适配器按启动用户权限执行，不增加 bridge 工具审批层。测试或调试时不要再启动第二个 Pi 进程写入同一 session；companion 是当前 session 的唯一进程 owner。

## Windows 启动器说明

项目会尽量规避 `codex.ps1` 带来的执行策略问题：

- 优先查找 vendor `codex.exe`；
- 必要时通过 `cmd.exe` 包装 `codex.cmd`。

如果本机 PowerShell profile 本身受执行策略限制，终端仍可能打印相关警告。这通常不是 bridge 本身故障。

## 全局命令开发验证

如果希望当前工作区直接提供全局命令：

```bash
npm install -g .
```

开发阶段也可以使用：

```bash
npm link
```

区别：

- `npm link` 会让全局命令直接指向当前仓库源码；
- `npm install -g .` 会安装一份当前仓库的复制版本，后续代码更新后需要重新执行一次。

如果要验证当前源码构建出的真实 npm tarball，可以运行：

```bash
npm run smoke:global
```

常用完整验证命令：

```bash
npm run smoke:global -- --purge-global --clean-cache --full
```

参数说明：

| 参数 | 作用 |
| --- | --- |
| `--clean-cache` | 先执行 `npm cache clean --force` |
| `--purge-global` | 先卸载当前真实全局包 |
| `--full` | 额外执行 `npm run quality` |
| `--keep-tarball` | 保留生成的 tarball，方便排查 |

`smoke:global` 会先用当前源码打出真实 npm tarball，再执行 `npm install -g <tarball>` 安装到真实全局环境。脚本结束后，可以离开仓库目录运行 `wechat-*` 或 `wecom-*` 直接命令验证。

## 源码更新

如果使用源码仓库，可以用以下命令更新本地开发环境：

```bash
cd CLI-WeChat-Bridge
git pull
bun install
npm install -g .
```

## 质量门禁

推荐从小范围测试开始，再按风险扩大：

```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
```

完整质量门禁：

```bash
npm run quality
```

按目录运行测试：

```bash
bun test test/bridge
bun test test/companion
bun test test/daemon
bun test test/wechat
```

打包检查：

```bash
npm pack --dry-run --json
```

发布前应确认 tarball 包含 `bin/`、`dist/`、`README.md` 和 `LICENSE.txt`，不包含 `src/`、测试、runtime state、`node_modules/` 或本地 artifact。

## CLI 兼容性验证

```bash
npm run smoke:cli-compat
```

该检查使用 PATH 上的 CLI，验证 Codex 的 bridge 协议字段及 `--remote`、Claude Code 的 `--settings`/`--resume`、OpenCode 的 HTTP 健康响应，以及实际加载 Pi bridge extension 后的 session 状态和模型列表 IPC。OpenCode 每次 HTTP 探测最多等待 3 秒，总等待上限为 30 秒，避免服务刚监听 TCP 时的启动竞态拖延到 5 分钟。

定时 CI 同时覆盖 OpenCode 1.18.35 和最新 OpenCode 2。2026-10-08 本地能力验证使用 Codex 0.161.0、Claude Code 2.1.293、OpenCode 1.18.35/2.0.24 和 Pi 1.1.0。Pi 1.x 默认全屏，bridge 继续由 extension 接管原生 TUI，无需解析终端文本。

能力检查不调用模型，不代替完整对话测试。`npm run e2e` 使用本地测试通道与真实 CLI，不连接微信或企业微信；线上消息投递需分别验收。

## 本地 E2E 测试

仓库提供 `local` 通道，以 JSONL inbox 和 transcript 记录消息收发，沿用 daemon 的命令解析、调度和回复流程，无需远程通道凭据。E2E runner 通过 PTY host 运行真实 CLI，并提供只读 TUI 镜像；这些脚本仅用于源码仓库中的开发验证。

请先停止日常使用的 bridge / daemon，再在测试环境中运行：

```bash
npm run e2e -- --adapter claude --no-mirror
```

默认流程包含远程输入、本地终端输入、session 列表、实际 `/resume` 切换、恢复后的双向输入、`/model` 和 `/plan`。当前完整场景以 Claude Code 为主；runner 会调用真实模型，需要已有的 CLI 安装和模型访问配置。

可使用 `--only send,terminal-send` 选择场景、`--keep` 保留诊断输出；省略 `--no-mirror` 时会尝试打开只读终端镜像。运行部分场景时需考虑依赖，例如 `resume-send` 使用前面的 `resume` 场景选出的目标。

## 主要源码入口

| 文件 | 作用 |
| --- | --- |
| `src/daemon/wechat-daemon.ts` | daemon 装配、主循环、关闭与 IPC 请求分发（单桥接与多 CLI 模式共用） |
| `src/daemon/slot-manager.ts` | 按目录与 CLI 管理 slot、当前目录、主目录与窗口生命周期 |
| `src/daemon/inbound-router.ts` | 入站消息、切换指令、`/cd` 与排队 |
| `src/companion/local-companion-start.ts` | 直接启动器：加入或拉起 daemon，在当前终端运行 CLI |
| `src/daemon/daemon-link.ts` | daemon 本地 IPC endpoint 与请求协议 |
| `src/core/bridge-message-router.ts` | 统一处理授权、命令、approval、user input、defer 与 busy 顺序 |
| `src/core/bridge-defer.ts` | Codex 本地回合期间的输入延迟判断、队列提示与排空条件 |
| `src/bridge/bridge-adapters.ts` | `codex` / `claude` / `opencode` / `pi` 适配器入口 |
| `src/bridge/bridge-adapters.opencode.ts` | OpenCode 适配器实现 |
| `src/bridge/bridge-adapters.pi.ts` | Pi 原生 TUI adapter、extension IPC、session 跟随与最终回复实现 |
| `src/companion/pi-tui-bridge-extension.ts` | 注入 Pi TUI 的本地 bridge extension |
| `src/companion/local-companion.ts` | `wechat-claude` / `wechat-opencode` / `wechat-pi` 本地 companion 入口 |
| `src/companion/codex-remote-client.ts` | `wechat-codex` 本地客户端入口 |
| `src/companion/local-companion-start.ts` | 四个直接命令共用的智能启动入口 |
| `src/channels/wecom/setup.ts` | 企业微信 Bot 配置与操作者配对 |
| `src/channels/wecom/wecom-transport.ts` | 企业微信 WebSocket 长连接、消息和媒体收发 |
| `src/channels/wecom/wecom-message.ts` | 企业微信消息帧解析与通道消息转换 |
| `src/wechat/wechat-transport.ts` | iLink 消息收发 |
| `src/bridge/bridge-state.ts` | bridge 状态、锁与日志 |
| `src/wechat/setup.ts` | 登录与凭据初始化 |

## daemon IPC 请求

daemon 启动后会在本机写入 endpoint 文件，外部程序通过其中的端口和 token
发送一行一个 JSON 请求。`send_text` 只负责向 WeChat 或 WeCom 会话发送文本；
`forward_input` 则把外部输入交给指定 adapter slot，仍然经过 daemon 原有的
approval、structured user input、busy 和 Codex 本地回合 defer 检查。

`send_text.context` 只能使用 `final_reply`、`message`、`notice`、
`approval_required`、`user_input_required`、`mirrored_user_input`、
`session_switched`、`thread_switched`、`task_failed`、`fatal_error`、
`inbound_error` 或 `thinking`。未知值会被拒绝。

同一个 adapter slot 的 `forward_input` 按到达顺序串行化；slot 已经占用时，
请求会返回 busy，不能覆盖之前输入的 conversation。Codex 正在本地回合时，
请求会进入该 slot 的有限 deferred queue，并在回合完成后按顺序提交。若目标
visible CLI 没有成功连接，daemon 会返回 `not_activated`，不会提交输入。

WeCom 请求应携带 `conversationId` 和 `recipientId`。daemon 会把这两个字段
绑定到本次输入和后续输出，因此切换 active adapter 不会把另一个 slot 的
notice、approval、错误或最终回复发到错误会话。

## 扩展信道

`src/core/channel-types.ts` 中的 `BRIDGE_CHANNEL_DISPLAY_NAMES` 统一维护信道 ID 和显示名称，`BridgeChannelId` 类型及 CLI 信道校验由此派生。启动日志、帮助和 Codex attach 成功提示使用当前选择的信道。

新增远程信道时，需要补齐以下入口：

1. 在名称表中登记信道，并在 `src/channels/<channel>/` 实现配置、传输和 driver。
2. 在 `src/channels/channel-driver-factory.ts` 接入 driver，在 bridge 和 daemon 启动流程中接入对应凭据与 transport。输出端口也必须注册：standalone bridge 的 `portFactories` 覆盖全部远程信道，daemon 的 `createWechatChannelPort` 选择对应的 `ChannelPort`。
3. 在 `src/companion/local-companion-start.ts` 的 `channelCredentialSetups` 注册初始化函数。该映射覆盖全部远程信道，遗漏会触发类型检查错误；后台启动参数会直接传递所选信道。
4. 添加 `bin/<channel>-*.mjs`、`package.json` 命令映射及对应测试。参考 `test/companion/channel-launcher.test.ts`，覆盖帮助、成功提示、错误日志和 attach 状态校验。

Codex attach 会清空旧的桥接会话状态，再附加到当前 live thread；不会因此创建新 Codex 会话。只有状态文件与活跃锁的实例、工作区、adapter、信道及显式指定的 thread 一致，启动器才报告成功。`local` 是测试用回环信道，不提供 companion 启动器。

## 相关说明

- 运行配置和环境变量见 `docs/configuration.md`。
- 状态文件、日志和迁移排查见 `docs/troubleshooting.md`。
- `bin/*.mjs` 是发布包入口源文件，不是生成文件；修改后需要保持 LF 行尾。
- release 流程见 `docs/releases/README.md` 和 AGENTS.md 中的发布清单。
