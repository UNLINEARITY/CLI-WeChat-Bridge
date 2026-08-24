# 开发说明

本文记录源码运行、测试、构建、全局安装验证和主要源码入口。安装和日常使用说明见 README。

## 环境准备

需要：

- [Node.js](https://nodejs.org/en/download) `>= 24.0.0`
- [Bun](https://bun.sh/docs/installation) `>= 1.0.0`
- 至少一个本地 CLI：Codex、Claude Code、OpenCode 或 Pi

克隆并安装依赖：

```bash
git clone https://github.com/UNLINEARITY/CLI-WeChat-Bridge
cd CLI-WeChat-Bridge
bun install
```

源码模式依赖 Node 24 的 TypeScript strip-types 能力；发布包仍然需要先构建 `dist/*.js`。

## 源码模式命令

| 场景 | 命令 |
| --- | --- |
| 微信登录初始化 | `npm run setup` |
| 启动 daemon | `npm run daemon` |
| Codex bridge | `npm run bridge:codex` |
| Codex companion | `npm run codex:panel` |
| Codex 单命令启动器 | `npm run codex:start` |
| Claude bridge | `npm run bridge:claude` |
| Claude companion | `npm run claude:companion` |
| Claude 单命令启动器 | `npm run claude:start` |
| OpenCode bridge | `npm run bridge:opencode` |
| OpenCode companion | `npm run opencode:panel` |
| OpenCode 单命令启动器 | `npm run opencode:start` |
| Pi bridge | `npm run bridge:pi` |
| Pi companion | `npm run pi:companion` |
| Pi 单命令启动器 | `npm run pi:start` |

如果需要额外参数，可以追加在脚本后。例如：

```bash
npm run daemon -- --adapter codex
npm run bridge:claude -- --cwd D:\work\my-project
npm run opencode:start -- --cwd D:\work\my-project
npm run pi:start -- --cwd D:\work\my-project --model openai/gpt-5.6-sol
```

`bridge:*` 与 `*:companion` 是维护者源码调试入口，不会发布为 `wechat-bridge*` 全局命令。普通用户应直接运行 `wechat-codex`、`wechat-claude`、`wechat-opencode`、`wechat-pi` 或 `wechat-daemon`。

## Pi 原生 TUI 接管说明

Pi companion 启动一个长期运行的 `pi --approve --extension <bridge-extension>` 子进程，并使用 `stdio: "inherit"` 把当前可见终端直接交给 Pi。本地键盘和微信输入共享这一原生 TUI 进程及其当前 session；微信输入由 extension 调用 `pi.sendUserMessage()`，`/stop` 调用 extension context 的 `abort()`，`/new` 和 `/new-session` 通过 command context 新建 session。

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

`smoke:global` 会先用当前源码打出真实 npm tarball，再执行 `npm install -g <tarball>` 安装到真实全局环境。脚本结束后，可以离开仓库目录运行 `wechat-codex` 等直接命令验证。

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

## 主要源码入口

| 文件 | 作用 |
| --- | --- |
| `src/bridge/wechat-bridge.ts` | bridge 主事件循环 |
| `src/daemon/wechat-daemon.ts` | 常驻 WeChat daemon 与多 CLI slot 管理 |
| `src/daemon/daemon-link.ts` | daemon 本地 IPC endpoint 与请求协议 |
| `src/bridge/bridge-adapters.ts` | `codex` / `claude` / `opencode` / `pi` 适配器入口 |
| `src/bridge/bridge-adapters.opencode.ts` | OpenCode 适配器实现 |
| `src/bridge/bridge-adapters.pi.ts` | Pi 原生 TUI adapter、extension IPC、session 跟随与最终回复实现 |
| `src/companion/pi-tui-bridge-extension.ts` | 注入 Pi TUI 的本地 bridge extension |
| `src/companion/local-companion.ts` | `wechat-claude` / `wechat-opencode` / `wechat-pi` 本地 companion 入口 |
| `src/companion/codex-remote-client.ts` | `wechat-codex` 本地客户端入口 |
| `src/companion/local-companion-start.ts` | 四个直接命令共用的智能启动入口 |
| `src/wechat/wechat-transport.ts` | iLink 消息收发 |
| `src/bridge/bridge-state.ts` | bridge 状态、锁与日志 |
| `src/wechat/setup.ts` | 登录与凭据初始化 |

## 相关说明

- 运行配置和环境变量见 `docs/configuration.md`。
- 状态文件、日志和迁移排查见 `docs/troubleshooting.md`。
- `bin/*.mjs` 是发布包入口源文件，不是生成文件；修改后需要保持 LF 行尾。
- release 流程见 `docs/releases/README.md` 和 AGENTS.md 中的发布清单。
