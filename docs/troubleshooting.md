# 问题排查

本文记录 CLI WeChat Bridge 的常见问题、已知限制和排查入口，包括状态文件、网络发送、会话同步、审批行为以及微信、企业微信与 Telegram 通道。

## 数据目录与状态文件

默认运行数据目录是：

```text
~/.cli-bridge
```

如果设置了 `CLI_BRIDGE_DATA_DIR`，状态文件和日志会写入对应目录。运行时环境变量的完整说明见 [运行配置](configuration.md)。

未设置自定义数据目录时，登录凭据默认写入：

```text
~/.cli-bridge/account.json
```

登录成功后会清理旧的 `sync_buf.txt` 和 `context_tokens.json`，避免旧会话状态污染新的登录状态。

从旧版本升级时，bridge 会自动从旧的 `~/.claude/channels/wechat` 迁移数据到 `~/.cli-bridge`，包括登录凭据、同步游标、上下文 token、工作区状态和已接收附件；已有的新目录文件不会被覆盖，旧目录也会原样保留。旧运行锁不会迁移，旧 `bridge.log` 会保存为 `legacy-bridge.log`，避免覆盖新的运行日志。

主要文件如下：

| 路径 | 作用 |
| --- | --- |
| `account.json` | 微信凭据 |
| `wecom/account.json` | 企业微信 Bot 凭据与操作者配对信息 |
| `telegram/account.json` | Telegram Bot Token、操作者 user ID 与私聊 chat ID |
| `sync_buf.txt` | iLink 增量同步游标 |
| `context_tokens.json` | 微信上下文 token 缓存 |
| `bridge.log` | bridge、daemon、适配器与各信道发送失败日志 |
| `bridge.lock.json` | 独立 bridge 运行锁 |
| `daemon-endpoint.json` | 当前通道 daemon 的本地 IPC endpoint |
| `inbound-attachments/<date>/` | 微信入站图片和普通文件的本地保存目录 |
| `wecom/inbound-attachments/<date>/` | 企业微信入站媒体的本地保存目录 |
| `telegram/inbound-attachments/` | Telegram 入站图片、文件、视频与音频的本地保存目录 |
| `workspaces/<workspace-key>/bridge-state.json` | 当前工作区状态、会话和 adapter 状态 |
| `workspaces/<workspace-key>/codex-panel-endpoint.json` | 当前工作区 companion endpoint；文件名保留历史兼容 |
| `workspaces/<workspace-key>/<adapter>-companion-endpoint.json` | daemon / 多适配器模式下的 companion endpoint |

如果微信没有收到回复，优先确认 `bridge.log` 中是否出现 `wechat_send_failed`、`UND_ERR_CONNECT_TIMEOUT`、`context_token`、`endpoint`、`final_reply` 或 adapter 相关错误。

## Telegram 配对或消息收发异常

- 运行 `telegram-setup --check` 校验已配置的 Bot Token；401 表示 token 被拒绝，需要核对 BotFather 提供的值并重新配对。
- 配对必须在机器人私聊内发送终端显示的 `/pair <code>`，有效期为 10 分钟；后续使用同一 Telegram 账号发送任务。
- 409 冲突通常来自同一 Bot Token 被其他 bridge、daemon 或程序轮询占用。配对和日常运行也不能同时轮询；先停止旧程序再重试。
- 如果这个机器人曾配置 webhook，需先通过官方 [`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) 移除，再使用本项目的长轮询。
- 网络异常时确认启动 bridge 的 Node.js 进程能访问 `api.telegram.org`；手机 Telegram 可以连接，不代表本地 Node.js 的代理配置已生效。
- 没有收到最终回复时，检查 `bridge.log` 的 `final_reply`、`telegram_send_started`、`telegram_send_completed`、`telegram_send_failed` 和 `telegram_forward_failed`。升级前独立 bridge 误走微信端口的错误 `WeChat channel cannot send to telegram` 已在 1.2.3 修复；升级后重启 bridge 或重新 attach，使运行进程加载新代码。

## `wechat-*` / `wecom-*` / `telegram-*` 提示找不到 bridge

通常原因是：

- 可见 CLI 与内部 runtime 不在同一个工作目录；
- 当前工作区 endpoint 文件来自旧进程或已经失效。

请在目标项目目录重新运行对应通道的直接命令。直接命令会自动复用同目录同通道 daemon，或在没有 daemon 时重建内部 runtime 和可见 CLI。

## 全局命令不存在

请确认已经安装正式包：

```bash
npm install -g cli-wechat-bridge@latest
```

如果命令仍不存在，请检查 npm 全局 bin 目录是否已加入 `PATH`。使用源码仓库提供全局命令的方式见 [开发说明](development.md#全局命令开发验证)。

## npm 阻止安装脚本（Linux / 较新 npm）

如果全局安装看似完成，但出现类似警告：

```text
npm warn install-scripts cli-wechat-bridge@<installed-version> ... blocked because ... allowScripts
npm warn install-scripts node-pty@1.1.0 ... blocked because ... allowScripts
```

说明 npm 没有运行 bridge 的 `postinstall`，也没有运行 `node-pty` 的原生模块安装脚本。安装命令可能仍以成功状态退出，但 Claude Code 等依赖 PTY 的路径可能无法正常工作，macOS/Linux 上的 `spawn-helper` 执行权限修复也不会生效。

请执行干净重装，并在同一条安装命令中同时指定包名和允许的脚本包：

```bash
npm uninstall -g cli-wechat-bridge
npm install -g cli-wechat-bridge@latest --allow-scripts=cli-wechat-bridge,node-pty
```

如果希望后续升级继续使用该信任配置，可以写入用户级 npm 配置，再正常安装：

```bash
npm config set allow-scripts=cli-wechat-bridge,node-pty --location=user
npm install -g cli-wechat-bridge@latest
```

不要省略安装包名。以下命令是错误的：

```bash
npm install -g --allow-scripts=cli-wechat-bridge,node-pty
```

没有 `cli-wechat-bridge@latest` 时，npm 会尝试把当前目录作为待安装项目，并读取当前目录的 `package.json`；在用户主目录执行时通常会报：

```text
ENOENT: no such file or directory, open '/home/<user>/package.json'
```

重装完成后运行：

```bash
wechat-daemon --doctor
```

确认 `node-pty` 显示为已加载，再重新启动 daemon 和可见 CLI。

## PTY 不可用 / 回退模式

启动 bridge 后如果看到以下警告：

```text
[警告] PTY 不可用 — 已切换到回退模式（TERM=dumb）。
```

说明 `node-pty` 原生模块未能加载，bridge 已自动切换到 `child_process` 回退模式。

**注意**：Claude Code 适配器当前通过 PTY 交互模式工作，在回退模式下可能无法正常桥接。Codex 适配器主要通过 WebSocket RPC 通信，通常不受影响。OpenCode 和 Pi 适配器不依赖 node-pty。

## Pi 启动或会话异常

先确认本机可执行 `pi`，并检查环境：

```bash
pi --help
wechat-pi --doctor
```

`wechat-pi` 会启动并托管唯一的原生 `pi --approve --extension <bridge-extension>` TUI。当前窗口里显示的就是用户平时使用的 Pi，微信通过注入的本地 extension 接管同一 session。不要再运行第二个 Pi 进程写入同一 session 文件，否则会造成会话竞争或 transcript 状态不一致。需要新会话时，在 Pi TUI 或微信使用 `/new` / `/new-session`；需要中断当前任务时使用 `/stop`。

Pi 使用启动 `wechat-pi` 的本地用户权限，bridge 不增加工具审批层。`--approve` 表示信任当前项目的 Pi 本地配置和资源，不是按工具逐项授权。原生 Pi 的主题、快捷键、模型选择和 extension 交互界面都会保留；如果看到的只是简单 `pi>` 文本提示符，请确认已重新安装包含原生 TUI 接管实现的 bridge 版本。

### 修复方法

**Linux（最常见）：**

Linux 没有 node-pty 预编译包，需要本地编译：

```bash
# Debian / Ubuntu
sudo apt install build-essential python3

# RHEL / Fedora / CentOS
sudo dnf groupinstall "Development Tools" && sudo dnf install python3

# Alpine
apk add build-base python3
```

安装编译工具后，重新安装 bridge：

```bash
npm install -g cli-wechat-bridge@latest
```

**Windows：**

Windows 包含预编译模块，但以下情况可能导致加载失败：

- **Windows 版本过低**：ConPTY 需要 Windows 10 build 18309+，运行 `winver` 查看当前版本
- **Node ABI 不匹配**：Node.js 大版本升级后预编译包可能不兼容，运行 `npm rebuild node-pty` 或重新安装
- **缺少 Visual C++ Redistributable**：下载安装 [vc_redist.x64.exe](https://aka.ms/vs/17/release/vc_redist.x64.exe)
- **权限不足**：尝试以管理员身份运行终端

```bash
npm rebuild node-pty
# 或重新安装
npm install -g cli-wechat-bridge@latest
```

**macOS：**

```bash
xcode-select --install
npm rebuild node-pty
```

### 验证修复

运行以下命令确认 node-pty 可正常加载：

```bash
node -e "require('node-pty'); console.log('node-pty OK')"
```

或使用内置环境检查：

```bash
wechat-daemon --doctor
```

如果输出 `node-pty: ✓ loaded`，重启 bridge 即可使用完整 PTY 模式。

### spawn-helper 缺少执行权限（macOS / Linux）

即使 `node-pty` 能正常加载（`--doctor` 显示 `node-pty: ✓ loaded`），PTY 仍可能起不来。典型症状是 Claude 适配器报：

```text
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

或 bridge 日志中出现 `posix_spawnp failed`。原因是 node-pty 发布包里的 `spawn-helper` 预编译二进制权限为 `0644`（缺少执行位），`posix_spawnp` 无法 exec，导致 PTY 启动失败并回退到非 PTY 模式，而 Claude 适配器在该模式下会进入 `--print` 非交互模式并报错。

本项目的 `postinstall` 脚本会在安装后自动为 `spawn-helper` 补上执行位。如果仍遇到该问题（例如使用了 `--ignore-scripts` 安装），可手动修复：

```bash
PKG="$(npm root -g)/cli-wechat-bridge/node_modules/node-pty"
chmod +x "$PKG/prebuilds/darwin-arm64/spawn-helper" \
         "$PKG/prebuilds/darwin-x64/spawn-helper" 2>/dev/null
```

修复后重启 bridge 即可恢复完整 PTY 模式。

## 微信上提示没有 context token

通常表示当前联系人还没有建立可用的 iLink 上下文。启动 bridge 后，先由 owner 账号向 Bot 发送一条普通微信消息，一般即可建立上下文。

如果冷启动或长时间闲置后直接从本地终端先发消息，本地 CLI 可能已经完成任务，但微信出站发送会因为旧 `context_token` 失效而失败。此时先从微信侧发一条新消息，再继续后续任务。

当前版本会把因 context token 缺失或过期而未能发送的文本暂存到当前工作区的 `pending-wechat-messages.json`，下一条成功收到的微信消息刷新 token 后自动按顺序补发。若 bridge 在补发前退出，重启同一工作区的 bridge 或 daemon 后仍会继续尝试。

## `wechat_send_failed` 或 `UND_ERR_CONNECT_TIMEOUT`

如果本地 CLI 已经完成任务，但微信仍没有收到回复，请检查：

```text
~/.cli-bridge/bridge.log
```

日志中出现 `wechat_send_failed`、`UND_ERR_CONNECT_TIMEOUT` 或 `ilinkai.weixin.qq.com:443` 时，通常是 bridge 到 iLink 的出站网络或代理问题，而不是本地 CLI 没有完成任务。

请确认当前终端是否继承：

```text
HTTP_PROXY
HTTPS_PROXY
ALL_PROXY
NO_PROXY
NODE_USE_ENV_PROXY=1 (Node.js 24+)
```

建议保留：

```text
NO_PROXY=127.0.0.1,localhost,::1
```

这样本地 daemon / companion IPC 不会被代理转发。

提示：Node.js 的内置 `fetch` 默认**不读取**代理环境变量。如果你的网络必须经代理才能访问 `ilinkai.weixin.qq.com`，Node.js 24 及以上请设置 `NODE_USE_ENV_PROXY=1` 后重启桥接；Node.js 22.13 不使用 `NODE_OPTIONS=--use-env-proxy`，应升级 Node.js 或为运行环境提供可用的直连网络。`--doctor` 的"微信服务可达性"一项会在检测到该情况时给出提示。

## 启动器被拒绝，或远程命令提示"当前模式下不可用"

桥接按打开的窗口渐进升级（见[渐进桥接模式](bridge-modes.md)），以下提示都是模式规则，不是故障：

1. **`... is already running for <目录> in another terminal, and this bridge runs several CLI types`**：桥接处于多 CLI 模式，这个目录已经有同一种 CLI。多 CLI 模式下同一目录每种 CLI 只开一个；要同时跑两个，请在另一个目录运行，桥接会升级为多目录模式。
2. **`The <通道> bridge is running several windows of one CLI type ...`**：桥接处于同类型多实例模式，这个目录只能再开同一种 CLI。要用其他 CLI，请在另一个目录运行，或先关闭这些窗口（临时 daemon 会随最后一个窗口退出，下次从单桥接开始）。
3. **`/cd`、`/all`、`/1` 提示不可用**：`/cd` 只在跨多个目录时开放，`/all` 只在有多个窗口时开放，`/1`、`/2` 只在同一种 CLI 开了多个窗口时开放。单桥接中可以发送 `/open` 再开一个同类型窗口。
4. **回复突然带上了 `[codex]`、`[pi-1]` 前缀**：桥接已升级，前缀用于区分回复来自哪个窗口。模式只升不降；关闭多余窗口不会去掉前缀，退出临时 daemon（关闭全部窗口）后下次重新从单桥接开始。

`/status` 的"模式"一行显示当前模式；`bridge.log` 中的 `bridge_mode_upgraded`、`window_refused`、`launcher_refused` 记录每次升级与拒绝的原因。

## 消息发出去桥接没反应（环境看起来一切正常）

按以下顺序排查，这些都是"部分用户正常、部分用户不可用"的高频根因：

1. **CLI 靠环境变量认证**（如 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`）：旧版本在 Windows 上启动子进程时会丢弃这些变量。请升级到最新版本；并确保这些变量在启动桥接的同一终端会话中可见。
2. **中文用户名 + 非 UTF-8 代码页**：旧版本生成的 Claude hook 批处理脚本在 GBK 代码页下路径乱码，导致 Claude 的回复永远到不了微信（启动约 15 秒后会出现 hook 健康检查警告）。升级到最新版本即可；`--doctor` 的"控制台代码页"一项会标出风险组合。
3. **系统时钟偏差**：桥接会忽略启动前的积压消息，本机时钟偏差过大会把新消息误判为积压。新版本在发生忽略时会主动向微信发送提示，`--doctor` 的"系统时钟"一项会显示与服务器的偏差。
4. **多个进程在抢同一账号的消息**：残留的 `wechat-daemon`/bridge 进程、或在 Claude Code 中同时配置了 wechat MCP server 时，消息会被另一个进程先取走。运行 `--doctor` 查看守护进程与桥接锁状态，关掉多余进程。
5. **同一账号在另一台机器重新扫码登录**：旧机器的会话会失效（`errcode=-14 session timeout`），需要重新运行 `wechat-setup`。

## `codex is still working...`

该提示只应在当前确实存在活动任务时出现。

如果偶发出现：

1. 先确认本地 `wechat-codex` 是否真的仍在执行任务；
2. 必要时在对应远程通道发送 `/stop`；
3. 检查 `~/.cli-bridge/bridge.log` 和当前工作区的 `bridge-state.json`。

## 本地 `/resume` 后远程通道不同步

请优先重新运行对应的 `wechat-*` 或 `wecom-*` 直接命令，确保内部 runtime 与可见 CLI 来自同一安装版本。

微信和企业微信侧的 `/resume` 均支持 Codex、Claude Code、OpenCode 和 Pi。命令只列出当前目录（daemon 中为 `/cd` 选中的目录）内的最近会话；切换前需要当前适配器处于 idle，且没有待审批或待回答请求。

Codex 会先校验目标 thread 的 cwd、root 和 active 状态，再执行 `thread/resume` 与可见客户端切换；Claude Code 会等待 `SessionEnd(reason=resume)` 和目标 `SessionStart(source=resume)`；OpenCode 与 Pi 会等待可见 TUI 的 session 切换确认。任何一步失败时，bridge 保留原会话，不提交新的 shared session。

部分设备可能存在第一次本地输入不同步到微信的情况，可以先从对应远程通道发送一条普通消息来建立上下文。

## 审批与权限请求

bridge 只处理 CLI 自己发起的权限请求：CLI 以完全权限或免审批模式运行时不会询问，bridge 也不会另加审批。bridge 也不改写 CLI 的审批与沙箱设置：Codex 线程沿用你本地 Codex 配置（`approval_policy`、`sandbox_mode`、自动审查等），从远程通道发起的任务同样按这些设置运行。Codex、Claude Code 和 OpenCode 发来的请求按同一套规则判断，以下情况转发到远程通道确认，其余自动放行（包括普通联网）：

- 删除、提权、关机、强制重置或丢弃改动等危险命令；
- `git push`、`npm publish`、`docker push`、`gh release`、`gh pr merge`、部署类命令以及 `ssh`/`scp` 等对外操作；
- 写入工作区以外的文件，或访问工作区以外的目录；
- MCP 工具调用、Claude Code 的计划确认以及无法识别的权限类型。

Codex 的文件修改请求不附带文件路径，只有授权目录位于工作区内时才自动放行，其余转发确认。Codex 的 MCP 工具审批会转发到远程通道；MCP 服务器要求填写的表单、打开的链接或设备验证只能在本地终端完成，远程通道会收到提示。

转发到远程通道的审批消息会列出该请求支持的回复：`/confirm`、`/deny` 之外，`/deny <理由>` 拒绝并把理由交给模型，`/always` 本会话内允许同类操作（Codex、Claude Code；只作用于当前会话，不写配置文件），`/abort` 拒绝并停止本轮。Codex 拒绝时不能附带文字，理由会在本轮结束后作为下一条消息发送；OpenCode 的"总是允许"会写入项目规则，因此不提供 `/always`。

本轮自动放行的操作按类别计数，附在最终回复末尾一行，例如"本轮自动放行：2 条命令、1 个文件修改"。

在远程通道发送 `/auto off` 可临时关闭自动放行（每个权限请求都转发确认），`/auto on` 重新开启，`/auto` 查看当前状态；开关作用于所有窗口，daemon 重启后恢复默认。默认值由环境变量 `CLI_BRIDGE_STRICT_APPROVAL=1` 决定（设置后默认关闭）。`/auto off` 不会撤销已启动的 Claude Code 窗口里的 `WebFetch(domain:*)` 联网放行规则，该规则只在启动时按环境变量决定。较早版本的 CLI 窗口不支持热切换，需要重启窗口。

Codex、Claude Code 等适配器会在 bridge 能识别的审批请求上同步到微信或企业微信侧处理。少数底层 CLI 自己弹出的本地 TUI 安全确认，如果没有暴露给 bridge，仍可能需要在本地终端处理。

如果普通查找、读目录、读文件等低风险命令频繁要求本地终端审批，请保留 `bridge.log` 和对应终端输出后提交 issue。

## 企业微信连接与附件发送

`wecom-setup --check` 可以验证已保存的 Bot ID、Secret 和配对用户。企业微信规定每个智能机器人同时只能保持一个有效长连接；如果日志出现 `connected by another process` 或 `event.disconnected_event`，请关闭使用同一 Bot ID 的其他 `wecom-daemon`、bridge 或 OpenClaw 插件实例，再重新启动。

企业微信附件下载地址只有五分钟有效，因此 bridge 会在收到消息时立即下载并解密。下载失败、超时或超过 `WECOM_MAX_INBOUND_*_MB` 限制时，CLI prompt 中会出现明确的附件不可用说明。

官方 `@wecom/aibot-node-sdk@1.0.7` 的大文件分片上传存在已公开的延迟 ACK 问题。当前实现会逐个发送附件，失败时向企业微信返回文件名和错误类型，不会静默丢失，也不会修改 SDK 私有字段。待官方发布修复版本后再升级依赖。

企业微信智能机器人当前只支持内部单聊和内部群聊，不支持外部群或客户群。主动消息只能发送到已经与机器人发生过交互的会话。

## 已知限制

- 一个 daemon 可以管理多个工作目录：在其他目录运行直接启动命令会加入已运行的 daemon，远程通道用 `/cd` 查看和切换；只能切换到本机已打开的目录，不能从远程通道打开新目录。
- 微信和企业微信入站图片、文件及视频会保存为本地路径并转发给 CLI；bridge 本身不做 OCR，也不自动抽取 PDF / DOCX 正文。
- 同一工作区同一通道不应同时运行 daemon 和独立 bridge；同目录启动器会优先委托已有 daemon。
