# CLI WeChat Bridge

<p align='center'><img src='docs/images/logo.png' width=90%></p>

<p align="center"><img alt="Typing SVG" src="https://readme-typing-svg.herokuapp.com?font=JetBrains+Mono&amp;weight=600&amp;duration=4000&amp;pause=500&amp;color=06C763&amp;center=true&amp;vCenter=true&amp;width=660&amp;lines=CLI+WeChat+Bridge+%E5%BE%AE%E4%BF%A1%E6%A1%A5%E6%8E%A5;%E7%9C%9F%E6%AD%A3%E7%9A%84%E2%80%9C%E7%BB%88%E7%AB%AF-%E5%BE%AE%E4%BF%A1%E2%80%9D%E5%8E%9F%E7%94%9F%E5%8F%8C%E5%90%91%E4%BA%A4%E4%BA%92"></p>

<p align="center">
  <a href="https://github.com/UNLINEARITY/CLI-WeChat-Bridge"><img alt="GitHub stars" src="https://img.shields.io/github/stars/UNLINEARITY/CLI-WeChat-Bridge?label=Stars&amp;style=for-the-badge&amp;logo=github&amp;color=0891b2&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/cli-wechat-bridge"><img alt="npm version" src="https://img.shields.io/npm/v/cli-wechat-bridge?label=npm&amp;style=for-the-badge&amp;logo=npm&amp;color=cb3837&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/cli-wechat-bridge"><img alt="npm downloads" src="https://img.shields.io/npm/dt/cli-wechat-bridge?label=Downloads&amp;style=for-the-badge&amp;logo=npm&amp;color=16a34a&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/@unlinearity/cli-wechat-bridge"><img alt="scoped npm downloads" src="https://img.shields.io/npm/dt/@unlinearity/cli-wechat-bridge?label=Scoped%20downloads&amp;style=for-the-badge&amp;logo=npm&amp;color=15803d&amp;labelColor=1c1917"></a>
  <a href="https://www.npmjs.com/package/cli-wechat-bridge">
  <img alt="License" src="https://img.shields.io/badge/License-AGPL--3.0-7c3aed?style=for-the-badge&labelColor=1c1917">
</a>
  <a href="https://github.com/UNLINEARITY/CLI-WeChat-Bridge/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/UNLINEARITY/CLI-WeChat-Bridge/ci.yml?branch=main&label=CI&style=for-the-badge&logo=githubactions&logoColor=white&labelColor=1c1917"></a>
</p>

**命令行工具的微信桥接**：本项目将微信消息桥接到本地运行的 [`Codex`](https://github.com/openai/codex)、[`Claude Code`](https://code.claude.com/docs/en/overview)、[`OpenCode`](https://github.com/anomalyco/opencode) 和 [`Pi`](https://github.com/earendil-works/pi)，同时把本地输出、审批请求与运行状态同步回微信。

项目围绕本地工作流设计，重点是保留**本地原生终端体验**：你仍然在本地使用原生 CLI 和高级启动参数，微信负责远程输入、结果回流与状态同步。

<p align='center'><img src='docs/images/animation.webp' width=90%></p>

## 文档导航

- [问题排查](docs/troubleshooting.md)：上下文 token、网络代理、本地 endpoint、已知限制等常见问题。
- [运行配置](docs/configuration.md)：数据目录、上传大小限制、调试开关等环境变量。
- [开发说明](docs/development.md)：源码运行、测试、构建、打包和全局 smoke 验证。
- [发布说明](docs/releases/README.md)：各版本变更与升级说明。
- [通信架构](docs/architecture.md)：各 CLI 适配器的通信机制、PTY / RPC 依赖分析和技术决策。

## 这个项目解决什么问题？

本项目适合这样的使用场景：

- 你的主工作流仍在本地终端中进行；
- 你希望继续使用 Codex、Claude Code、OpenCode、Pi 等原生 CLI，而不是迁移到网页或托管机器人；
- 你希望离开电脑后，仍能通过微信向本地会话发送请求，并接收必要输出和状态更新。

本项目不试图把微信变成新的主工作界面。它的定位是：

- 本地 CLI 仍然是主工作界面，并保持原生的使用逻辑；
- 微信是远程入口，用来接入本地会话；
- 会话一致性、线程状态和审批流仍以**本地会话为中心**。

## 快速开始

### 1. 环境要求

- [Node.js](https://nodejs.org/en/download) `>= 24.0.0`（建议直接安装官网 LTS 版本）
- 已安装以下任意一种本地 CLI，并尽量保持最新版本：
  - [Codex](https://github.com/openai/codex)
  - [Claude Code](https://code.claude.com/docs/en/overview)
  - [OpenCode](https://github.com/anomalyco/opencode) `>= 1.18.0 < 2.0.0`
  - [Pi](https://github.com/earendil-works/pi)（已验证 `0.84.2`；需要本机可执行 `pi` 命令）

### 2. 安装

发布版本可以直接从 npm 安装：

```bash
npm install -g cli-wechat-bridge@latest
```

安装后，可以在任意项目目录中使用 `wechat-daemon`、`wechat-codex-start`、`wechat-claude-start`、`wechat-opencode-start`、`wechat-pi-start` 等命令。

兼容性说明：旧包名 `@unlinearity/cli-wechat-bridge` 会继续同步发布，已经安装旧包名的用户可以正常升级；新用户优先使用更短的 `cli-wechat-bridge`。

<details>
<summary><b>安装遇到问题？（node-pty 原生模块）</b></summary>

本项目使用 `node-pty` 为 CLI 适配器提供完整终端模拟。**Claude Code 适配器当前通过 PTY 交互模式工作**，node-pty 不可用时会回退到兼容模式，但 Claude Code 在此模式下可能无法正常桥接；Codex 适配器主要通过 WebSocket RPC 通信，通常不受影响；OpenCode 适配器不依赖 node-pty；Pi 直接继承可见 companion 的真实终端，也不需要 node-pty 模拟。

**Linux 用户**（最常见）：需要原生模块编译工具：

```bash
# Debian / Ubuntu
sudo apt install build-essential python3
# RHEL / Fedora
sudo dnf groupinstall "Development Tools" && sudo dnf install python3
# Alpine
apk add build-base python3
```

安装编译工具后重新安装：`npm install -g cli-wechat-bridge@latest`

**macOS 用户**：如遇编译问题，安装 Xcode 命令行工具：`xcode-select --install`

**Windows 用户**：
- 需要 Windows 10 1809（build 18309）或更高版本
- 如果 node-pty 加载失败，运行 `npm rebuild node-pty` 或重新安装
- 确保已安装 [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)

运行 `wechat-daemon --doctor` 可快速检查环境状态。详见 [问题排查](docs/troubleshooting.md#pty-不可用--回退模式)。

</details>

### 3. 完成微信登录

全局安装后运行：

```bash
wechat-setup
```

登录流程会：

1. 获取微信登录二维码；
2. 在终端打印二维码；
3. 等待你在微信中扫码并确认；
4. 保存本地登录凭据。

![微信登录二维码](docs/images/image-0.png)

登录成功后，程序会清理旧的同步游标和上下文 token，避免旧会话状态污染新的登录状态。数据目录、状态文件和旧版本迁移说明见 [问题排查](docs/troubleshooting.md#数据目录与状态文件)。

首次安装或微信登录过期时，`wechat-codex-start`、`wechat-claude-start`、`wechat-opencode-start`、`wechat-pi-start` 也会在前台提示扫码登录。

### 4. 先从微信发一条同步消息（重要）

启动 bridge 后，建议先在微信里向 Bot 发送一条消息，例如 `hello`、你要执行的任务，或任意一句话。这样 bridge 能拿到最新的微信会话 `context_token`，之后本地终端中的输入、最终回复和审批提示才能稳定同步回微信。

如果冷启动或长时间闲置后直接从本地终端先发消息，bridge 通常仍会捕获这条本地输入并交给 Codex / Claude Code / OpenCode / Pi 处理，但回发到微信时可能因为旧的 `context_token` 失效而失败。表现是：本地已经有回复，微信暂时收不到；等你先从微信发来一条消息后，后续双向同步就能恢复正常。

### 5. 单命令启动桥接（兼容模式）

先进入需要操作的项目目录：

```bash
cd D:\work\your-project
```

然后选择一个单命令入口：

| 使用的本地 CLI | 启动命令 |
| --- | --- |
| Codex | `wechat-codex-start` |
| Claude Code | `wechat-claude-start` |
| OpenCode | `wechat-opencode-start` |
| Pi | `wechat-pi-start` |

这些启动器会自动完成以下动作：

1. 校验或刷新微信登录凭据；
2. 如果当前目录已有 `wechat-daemon`，则委托 daemon 切换到对应 CLI；
3. 如果没有 daemon，则复用当前目录中已运行的 bridge，或在当前目录启动新的 bridge；
4. 如果已有独立 bridge 正在服务其他目录，则停止旧 bridge 并切换到当前目录；
5. 等待当前目录对应的本地 companion endpoint 就绪；
6. 打开可见的本地 CLI 会话。

没有 daemon 时，`wechat-codex-start` / `wechat-claude-start` / `wechat-opencode-start` / `wechat-pi-start` 仍按**单活工作区切换器**工作：

- 同一时间只有一个项目与微信对话；
- 在当前目录重复执行是幂等的；
- 如果当前目录已经有可见 companion / panel 在运行，则不会重复打开第二个窗口；
- 如果检测到可见端仍在运行但 worker 状态异常（如 `stopped` / `error`），会自动重启 bridge 再重新打开可见端；
- 在其他目录执行会显式切换活动工作区。

### 6. 常驻 daemon 模式（支持多 CLI 切换）

如果你希望微信连接长期保持在线，并在 Codex / Claude Code / OpenCode / Pi 之间来回切换，可以在项目目录启动统一 daemon：

```bash
cd D:\work\your-project
wechat-daemon
```

启动后，在微信里发送以下指令即可选择当前活动终端：

| 指令 | 行为 |
| --- | --- |
| `/codex` | 切换到 Codex |
| `/claude` | 切换到 Claude Code |
| `/opencode` | 切换到 OpenCode |
| `/pi` | 切换到 Pi |

daemon 启动后，后续切换都可以直接从微信发起；如果对应 CLI 还没有可见窗口，daemon 会自动打开或复用它，不需要再手动运行 `wechat-codex`、`wechat-claude`、`wechat-opencode` 或 `wechat-pi`。

![多CLI 示例](docs/images/image-9.png)

当前 daemon 行为如下：

- daemon 绑定启动时的工作目录；暂不支持在微信里切换工作目录；
- 启动时会自动接管并清理旧的单 bridge 进程、失效 lock 和旧 endpoint；
- 切换适配器不会关闭之前的 CLI；
- 如果对应适配器已经有可见 CLI 在运行，则直接复用；
- 如果还没有对应 CLI，daemon 会自动打开一个新的可见终端；
- Codex / Claude / OpenCode / Pi 的重要输出都会带上 `[codex]`、`[claude]`、`[opencode]`、`[pi]` 标签再发回微信；
- 可以在微信里发送 `/daemon-stop` 停止 daemon。

也可以在启动时指定初始 CLI：

```bash
wechat-daemon --adapter codex
wechat-daemon --adapter claude --profile work
```

当同一工作目录已有 `wechat-daemon` 在运行时，`wechat-codex-start` / `wechat-claude-start` / `wechat-opencode-start` / `wechat-pi-start` 会自动委托给 daemon：请求 daemon 切到对应 CLI，并在需要时打开可见终端，不会停止 daemon 或关闭其他 CLI。

### 7. 手动双终端模式（高级调试）

如果你希望明确观察 bridge 与本地 CLI companion，也可以用两个终端分别启动。

| 适配器 | 终端 A：bridge | 终端 B：本地 companion |
| --- | --- | --- |
| Codex | `wechat-bridge-codex` | `wechat-codex` |
| Claude Code | `wechat-bridge-claude` | `wechat-claude` |
| OpenCode | `wechat-bridge-opencode` | `wechat-opencode` |
| Pi | `wechat-bridge-pi` | `wechat-pi` |

## 适配器支持情况

> 目前支持将本地文件发送到微信,微信也允许发送文件给本地 cli 解析 （注意模型本身要具备处理对应文件的能力！）

![文件传输](docs/images/image-8.png)

微信发来的图片和普通文件也会被接收并保存到本地：

- bridge 会将本地路径追加到转发给 Codex / Claude Code / OpenCode / Pi 的 prompt 中，模型可按需读取或解析这些文件；
- 当前不会自动 OCR 图片，也不会自动抽取 PDF / DOCX 正文；如需解析，由本地 CLI 根据路径完成。
- 具体保存位置见 [问题排查](docs/troubleshooting.md#数据目录与状态文件)。

| 适配器 | 当前状态 | 说明 |
| --- | --- | --- |
| `codex` | 已接入 | 双终端模式；本地 companion 作为线程权威；微信跟随本地线程 |
| `claude` | 已接入 | `wechat-bridge-claude` + `wechat-claude` 的双终端 companion 模式；会话切换、最终回复与审批元数据按 Claude session 语义同步 |
| `opencode` | 已接入 | [`OpenCode`](https://github.com/anomalyco/opencode) 适配器；`wechat-bridge-opencode` + `wechat-opencode` 的双终端 companion 模式；支持本地 session 切换跟随，微信侧支持 `/new` / `/new-session` |
| `pi` | 已接入 | `wechat-bridge-pi` + `wechat-pi`；`wechat-pi` 启动用户原生 Pi TUI，并通过本地 extension 让微信接管同一 session，支持最终回复、停止、新建和恢复 session |

Pi 按全权限本地代理运行：bridge 不增加工具审批层，并传入 `--approve` 信任当前项目；读写文件和执行命令均使用启动 `wechat-pi` 的本地用户权限。原生 TUI 的主题、快捷键、模型选择和 extension UI 都会保留。`wechat-pi` 本身就是被微信接管的 Pi TUI；不要再启动第二个 Pi 进程同时写入同一个 session 文件。

### Codex 示例

![Codex windows](docs/images/image-3.png)

![Codex Linux](docs/images/image-4.png)

### Claude Code 示例

![Claude Windows](docs/images/image-6.png)

![Claude Linux](docs/images/image-7.png)

### OpenCode 示例

OpenCode 模式下，微信侧支持 `/new` 或 `/new-session` 创建新 session；如果在本地 OpenCode CLI 中创建新 session，微信消息也会跟随新的 session。

## 命令说明

### 常用全局命令

| 类型 | 命令 |
| --- | --- |
| 登录与更新 | `wechat-setup`、`wechat-check-update` |
| 常驻 daemon | `wechat-daemon` |
| Codex | `wechat-bridge-codex`、`wechat-codex`、`wechat-codex-start` |
| Claude Code | `wechat-bridge-claude`、`wechat-claude`、`wechat-claude-start` |
| OpenCode | `wechat-bridge-opencode`、`wechat-opencode`、`wechat-opencode-start` |
| Pi | `wechat-bridge-pi`、`wechat-pi`、`wechat-pi-start` |

### Daemon CLI 参数

适用于：

- `wechat-daemon`

示例：

```bash
wechat-daemon --cwd D:\work\my-project
wechat-daemon --adapter codex
wechat-daemon --adapter claude --profile work
```

支持参数：

- `--cwd <path>`：指定 daemon 绑定的工作目录；
- `--adapter <codex|claude|opencode|pi>`：启动 daemon 后立即切换到指定 CLI；
- `--profile <name-or-path>`：传给 daemon 创建的对应适配器；
- `--no-open`：只创建 bridge slot，不自动打开可见 CLI。

### Bridge CLI 参数

适用于：

- `wechat-bridge`
- `wechat-bridge-codex`
- `wechat-bridge-claude`
- `wechat-bridge-opencode`
- `wechat-bridge-pi`

示例：

```bash
wechat-bridge --adapter codex --cwd D:\work\my-project
wechat-bridge-codex --cwd D:\work\my-project
wechat-bridge-claude --profile work
wechat-bridge-opencode --cwd D:\work\my-project
wechat-bridge-pi --cwd D:\work\my-project
wechat-bridge-codex --lifecycle companion_bound
```

支持参数：

- `--adapter <codex|claude|opencode|pi>`：通用入口 `wechat-bridge` 需要显式指定适配器；
- `--cwd <path>`：指定工作目录；
- `--profile <name-or-path>`：向适配器传入 profile；
- `--lifecycle <persistent|companion_bound>`：指定 bridge 生命周期；`wechat-*-start` 会使用 `companion_bound`。

### `wechat-*-start` 参数

示例：

```bash
wechat-codex-start --cwd D:\work\my-project
wechat-claude-start --profile work
wechat-opencode-start --cwd D:\work\my-project
wechat-pi-start --cwd D:\work\my-project --model openai/gpt-5.6-sol
```

支持参数：

- `--cwd <path>`：显式指定 bridge / companion 对应的工作目录；
- `--profile <name-or-path>`：转发给后台启动的 `wechat-bridge-codex` / `wechat-bridge-claude` / `wechat-bridge-opencode` / `wechat-bridge-pi`；
- `--timeout-ms <ms>`：等待当前目录 endpoint 的最长时间，默认 `15000`。

高级用法：除上述启动器参数外，未知参数会继续透传给可见的底层 CLI。这样既能保留微信登录、工作区切换与 bridge 生命周期管理，也能启用 Codex / Claude Code / OpenCode / Pi 自己的高级启动模式。

```bash
wechat-codex-start --yolo
wechat-codex-start --model gpt-5.2 --yolo
wechat-claude-start --dangerously-skip-permissions
wechat-claude-start --model sonnet --dangerously-skip-permissions
```

其中，`--yolo` 会传给 Codex；`--dangerously-skip-permissions` 会传给 Claude Code。它们只影响本地可见 CLI，不会覆盖 bridge 托管的 Codex remote 连接参数、Claude settings、微信登录状态或当前工作区锁。由于这两类参数会降低审批保护，建议只在可信工作区中使用。

## 微信侧支持的指令

| 指令 | 说明 |
| --- | --- |
| 普通文本 | 发送到当前活动会话 |
| `/codex` / `/claude` / `/opencode` / `/pi` | daemon 模式下切换活动 CLI；已有 CLI 会复用，没有则自动打开 |
| `/status` | 查看 bridge 当前状态 |
| `/stop` | 中断当前任务 |
| `/reset` | 重建当前本地会话 |
| `/new` 或 `/new-session` | OpenCode 或 Pi 模式下新建 session |
| `/confirm` / `/deny` | 处理 CLI 权限请求；需要一次性 code 的请求会在消息中提示具体确认格式 |
| `/daemon-stop` | daemon 模式下停止常驻进程 |
| `/bindings` | 查看当前所有表情绑定 |
| `/bind [表情] /命令` | 绑定表情到指定命令 |
| `/unbind [表情]` | 解除指定表情的绑定 |

说明：微信侧 `/resume` 目前暂时保持禁用；需要切换 Codex / Claude / OpenCode / Pi 会话时，优先在本地 companion 中使用 `/new` 或对应 CLI 的会话命令，微信会跟随本地活动会话。

### 表情绑定

Daemon 模式支持将微信表情映射为命令，在微信中发送表情即可快速触发操作。（不过注意，第一次启动相关cli的时候，最好不要带消息，等启动完成再“表情+文本”快速给指定 cli 发送消息。

![表情触发](docs/images/image-10.png)

**默认绑定：**

| 表情 | 命令 | 说明 |
| --- | --- | --- |
| `[OK]` | `/confirm` | 批准权限请求 |
| `[闭嘴]` | `/stop` | 中断当前任务 |
| `[拥抱]` | `/claude` | 切换到 Claude Code |
| `[强]` | `/codex` | 切换到 Codex |
| `[胜利]` | `/opencode` | 切换到 OpenCode |
| `[再见]` | `/daemon-stop` | 停止 daemon |

**管理命令：**

```
/bindings              查看当前所有绑定
/bind [表情] /命令     绑定表情到命令，如 /bind [微笑] /status
/unbind [表情]         解除绑定，如 /unbind [微笑]
```

**触发规则：**

- 表情必须出现在消息开头才会触发（如 `[OK]` 触发，`你好[OK]` 不触发）；
- 如果表情后面还有文本（如 `[拥抱]帮我写个脚本`），会先执行命令再将剩余文本作为消息转发；
- 大小写不敏感（`[OK]` 和 `[ok]` 等价）；
- 修改后立即生效并持久化到 `~/.cli-bridge/emoji-bindings.json`，重启 daemon 后保留。

## 工作区模型

本项目采用“当前目录即当前工作区”的模型：

- 从哪个目录启动 `wechat-bridge-codex` / `wechat-bridge-claude` / `wechat-bridge-opencode` / `wechat-bridge-pi`，哪个目录就是当前工作区；
- 对应的本地 companion 必须连接同一工作区；
- 不同工作区的运行状态相互隔离。

目前支持两种运行模型：

- 独立 bridge：单 owner、单 bridge、单活动工作区；
- `wechat-daemon`：单 owner、单 daemon、绑定一个启动工作区，但可在这个工作区内同时保留 Codex / Claude Code / OpenCode / Pi 四个 CLI slot。

对 `wechat-codex-start` / `wechat-claude-start` / `wechat-opencode-start` / `wechat-pi-start` 来说，这意味着：

- 如果同一工作区已有 daemon，它们会委托 daemon 切换 CLI；
- 如果没有 daemon，它们会作为**单活工作区切换器**工作；
- 当前目录重复执行是幂等的；
- 在其他目录执行会触发工作区切换，而不是并行多开。

## 版本更新

### 检查更新

运行以下命令检查是否有新版本：

```bash
wechat-check-update
```

该命令会显示：

- 当前安装的版本；
- 远程仓库的最新版本；
- 如果有更新，会提供详细的更新指引。

当启动 `wechat-bridge` 相关命令时（如 `wechat-bridge-codex`、`wechat-bridge-claude`），程序也会自动检查更新（每 24 小时一次）。自动检查在后台异步执行，不影响启动速度。

### 获取最新版本

如果你使用 npm 全局安装，建议直接执行：

```bash
npm install -g cli-wechat-bridge@latest
```

升级后请重启正在运行的 bridge 和 companion 终端，确保它们加载同一版本。

## 致谢

### 感谢支持

> 感谢 issue 反馈者和 PR 贡献者。

创作不易，如果觉得它有帮助或有意思，可以请喝杯奶茶。❤️

<p align='center'><img src='docs/images/wechat-tip.png' width=60%></p>

### 相关链接

主要依赖：

- [@opencode-ai/sdk](https://www.npmjs.com/package/@opencode-ai/sdk)：OpenCode session 和事件流客户端
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)：MCP server 入口使用的 TypeScript SDK
- [node-pty](https://github.com/microsoft/node-pty)：本地 PTY / ConPTY 进程桥接
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal)：终端二维码输出

运行与开发基础：

- [Node.js](https://nodejs.org/)：运行发布包和 CLI 入口
- [TypeScript](https://www.typescriptlang.org/)：源码语言和构建工具链
- [Bun](https://bun.sh/)：源码模式运行与测试工具
- [ESLint](https://eslint.org/)：代码检查

社区与参考：

- [Linux DO](https://linux.do/)：学 AI，上 L 站！
- [@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)：腾讯微信团队发布的 OpenClaw Weixin channel npm 包
- [openclaw-weixin](https://github.com/hao-ji-xing/openclaw-weixin)：早期 WeChat / Claude Code Channel 参考项目。

## License

本项目采用**双协议**授权：

**开源协议：[AGPL-3.0](LICENSE.txt)**

- 个人使用、学习、研究：完全免费
- 修改和衍生作品必须以相同协议（AGPL-3.0）开源
- 通过网络提供基于本项目的服务，也必须公开完整源代码

**商业授权**

如果你希望在闭源商业产品中使用本项目（不公开你的源代码），需要获得商业许可。请联系作者获取商业授权方案：

- GitHub: [@UNLINEARITY](https://github.com/UNLINEARITY)

<p align="center">
  <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=UNLINEARITY/CLI-WeChat-Bridge&type=timeline&legend=top-left">
</p>
