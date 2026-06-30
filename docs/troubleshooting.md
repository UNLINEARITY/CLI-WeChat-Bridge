# 问题排查

本文记录 CLI WeChat Bridge 的常见问题、已知限制和排查入口，包括状态文件、网络发送、会话同步和审批行为。

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
| `sync_buf.txt` | iLink 增量同步游标 |
| `context_tokens.json` | 微信上下文 token 缓存 |
| `bridge.log` | bridge、daemon、适配器和 WeChat 发送失败日志 |
| `bridge.lock.json` | 独立 bridge 运行锁 |
| `daemon-endpoint.json` | 当前 `wechat-daemon` 的本地 IPC endpoint |
| `inbound-attachments/<date>/` | 微信入站图片和普通文件的本地保存目录 |
| `workspaces/<workspace-key>/bridge-state.json` | 当前工作区状态、会话和 adapter 状态 |
| `workspaces/<workspace-key>/codex-panel-endpoint.json` | 当前工作区 companion endpoint；文件名保留历史兼容 |
| `workspaces/<workspace-key>/<adapter>-companion-endpoint.json` | daemon / 多适配器模式下的 companion endpoint |

如果微信没有收到回复，优先确认 `bridge.log` 中是否出现 `wechat_send_failed`、`UND_ERR_CONNECT_TIMEOUT`、`context_token`、`endpoint`、`final_reply` 或 adapter 相关错误。

## `wechat-codex` / `wechat-claude` / `wechat-opencode` 提示找不到 bridge

通常原因是：

- 还没有先启动对应的 `wechat-bridge-*`；
- bridge 与 companion 不在同一个工作目录；
- 当前工作区 endpoint 文件来自旧进程或已经失效。

建议先确认两个终端在同一目录。如果不想手动分两个终端，可以改用 `wechat-codex-start`、`wechat-claude-start` 或 `wechat-opencode-start`。这些启动器会自动复用同目录 daemon，或在没有 daemon 时启动 / 切换独立 bridge。

## 全局命令不存在

请确认已经安装正式包：

```bash
npm install -g cli-wechat-bridge@latest
```

如果命令仍不存在，请检查 npm 全局 bin 目录是否已加入 `PATH`。使用源码仓库提供全局命令的方式见 [开发说明](development.md#全局命令开发验证)。

## PTY 不可用 / 回退模式

启动 bridge 后如果看到以下警告：

```text
[警告] PTY 不可用 — 已切换到回退模式（TERM=dumb）。
```

说明 `node-pty` 原生模块未能加载，bridge 已自动切换到 `child_process` 回退模式。

**注意**：Claude Code 适配器当前通过 PTY 交互模式工作，在回退模式下可能无法正常桥接。Codex 适配器主要通过 WebSocket RPC 通信，通常不受影响。OpenCode 适配器完全不依赖 node-pty。

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
NODE_OPTIONS=--use-env-proxy
```

建议保留：

```text
NO_PROXY=127.0.0.1,localhost,::1
```

这样本地 daemon / companion IPC 不会被代理转发。

提示：Node.js 的内置 `fetch` 默认**不读取**代理环境变量。如果你的网络必须经代理才能访问 `ilinkai.weixin.qq.com`，请设置 `NODE_USE_ENV_PROXY=1`（Node 24+）后重启桥接；`--doctor` 的"微信服务可达性"一项会在检测到该情况时给出提示。

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
2. 必要时在微信发送 `/stop`；
3. 检查 `~/.cli-bridge/bridge.log` 和当前工作区的 `bridge-state.json`。

## 本地 `/resume` 后微信不同步

请优先确认 `wechat-bridge-codex` 与 `wechat-codex` 是否都已重启到同一版本。

微信侧 `/resume` 当前仍保持禁用。需要切换 Codex / Claude Code / OpenCode 会话时，优先在本地 companion 中使用原生 `/resume`、`/new` 或对应 CLI 命令，bridge 会跟随本地活动会话。

部分设备可能存在第一次本地输入不同步到微信的情况，可以先从微信发送一条普通消息来建立连接。

## 审批与权限请求

当前策略是尽量自动放行只读、查找、列目录等低风险操作；删除、覆盖、大范围移动、执行未知脚本、系统级修改等高风险操作应进入审批流程。

如果希望关闭所有自动放行（每个权限请求都转发到微信确认），设置环境变量 `CLI_BRIDGE_STRICT_APPROVAL=1` 后重启桥接。

Codex、Claude Code 等适配器会在 bridge 能识别的审批请求上同步到微信侧处理。少数底层 CLI 自己弹出的本地 TUI 安全确认，如果没有暴露给 bridge，仍可能需要在本地终端处理。

如果普通查找、读目录、读文件等低风险命令频繁要求本地终端审批，请保留 `bridge.log` 和对应终端输出后提交 issue。

## 已知限制

- 微信侧 `/resume` 暂时禁用，以避免远程和本地会话线程出现不一致。
- `wechat-daemon` v1 绑定启动工作区，暂不支持从微信切换到另一个本地目录。
- 入站图片和文件会保存为本地路径并转发给 CLI；bridge 本身不做 OCR，也不自动抽取 PDF / DOCX 正文。
- daemon 和独立 bridge 不应在同一工作区同时运行；同目录启动器会优先委托已有 daemon。
