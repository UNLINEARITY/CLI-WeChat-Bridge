# Codex 会话接入（实验性）

## 中文

`codex-bridge` skill 用于将**正在运行的 Codex 会话**接入微信、企业微信或 Telegram。桥接以额外客户端的身份连接 Codex 共享 app-server daemon，订阅当前线程的历史与实时事件。通道消息会作为新一轮输入提交到同一线程，回复和审批请求返回聊天通道，本地终端仍可正常使用。

该 skill 仅适用于 Codex，源码位于 `skills/codex-bridge/`。Claude Code、OpenCode 和 Pi 继续使用各自的启动命令。

安装 skill：

```bash
node "$(npm root -g)/cli-wechat-bridge/skills/codex-bridge/scripts/install.mjs"
```

从源码运行时，可直接执行 `node skills/codex-bridge/scripts/install.mjs`。skill 将安装到 `${CODEX_HOME:-~/.codex}/skills/codex-bridge`。

### 使用

在 Codex 终端会话中调用 `$codex-bridge`，并说明需要接入的消息通道。skill 会在项目目录中执行以下命令，通常无需手动运行；命令列在此处供排查问题时参考：

```bash
<channel>-codex --attach-current-session           # 前缀选择通道:wechat | wecom | telegram
<channel>-codex --attach-current-session --codex-thread-id <thread-id>
```

命令会将当前会话作为一个无需另开窗口的 Codex 实例加入 bridge daemon；若 daemon 尚未运行，会自动在后台启动。绑定成功后输出 `Attached Codex daemon thread <id>`。

接入的会话按一个 Codex 窗口参与桥接模式判断：同目录已有一个 Codex 窗口时，会获得 `codex-2` 等实例编号；已有其他类型的 CLI 时，进入多 CLI 模式，并遵循该模式下同类型只允许一个实例的规则；在另一个目录接入时，进入多目录模式。切换到同目录的其他线程可使用 `/resume`。如需停止整个 bridge daemon，在聊天通道发送 `/daemon-stop`。

### 工作原理

- Codex 0.162 及更高版本默认通过共享后台 daemon 托管 app-server。连接入口为 `~/.codex/app-server-control/app-server-control.sock`，使用 WebSocket JSON-RPC，同一用户下的进程可以连接。
- 桥接通过该 socket 连接，以 `thread/list` 查找当前工作目录中已加载的会话，再通过 `thread/resume` 加入运行中的线程，获取历史记录和实时事件，不接管原客户端的 rollout 写入锁。
- 通道输入通过 `turn/start` 提交到同一线程，不覆盖 `approvalPolicy` 或 `sandbox`，沿用会话自身的设置。审批、`request_user_input`、模型切换和中断操作使用桥接已有的处理流程。

### 适用范围与限制

- **使用内嵌 app-server 的会话无法接入**：Codex Desktop，以及通过 `--no-daemon`、`--oss` 或 `--profile` 启动的此类会话，不属于共享 daemon。尝试恢复这些会话会得到 `thread ... already has an active writer` 错误。
- Codex 0.162 之前的版本没有共享 daemon socket，无法使用附加模式。`wechat-codex` 自行启动 app-server 的常规流程不受此限制，其兼容性以所需协议能力的检查结果为准。
- 共享 daemon 的环境变量在其启动时确定。daemon 重启后，桥接会尝试重新连接并加入线程。
- 已有同通道的 `wechat-daemon`、`wecom-daemon` 或 `telegram-daemon` 运行时，会话会加入该服务，并在多目录模式的 `/cd` 列表中显示为 `codex（附加）`。若运行中的是其他通道的 daemon，需先将其停止。
- 附加模式不会自动更改已有会话的 MCP 配置，因此不会自动为其配置 1.5.0 新增的 CLI 协作工具。

### 桌面会话的连接限制

桌面应用的 Codex 后端以 `codex app-server` 子进程运行，启动参数不包含 `--listen`，使用标准输入输出（stdio）与宿主应用通信。JSON-RPC 消息只经过两者之间的私有管道，没有供桥接连接的监听端口或 Unix socket。`~/.codex/ipc/ipc.sock` 用于提供 IDE 上下文，例如已打开的文件和选区，并不是线程控制接口。

桌面进程同时持有 rollout 文件的写入锁，因此无法通过共享 daemon 恢复并接管该线程。终端会话在 Codex 0.162 及更高版本默认连接共享 daemon，才具备此处所需的多客户端连接条件。桌面会话能否接入，取决于上游是否提供可供外部客户端连接的控制接口。当前桥接不提供“关闭桌面会话后，再由桥接恢复并接管线程”的替代流程。

## English

The `codex-bridge` skill connects a **running Codex session** to WeChat, WeCom, or Telegram. The bridge joins the shared Codex app-server daemon as an additional client and subscribes to the current thread's history and live events. Messages from the channel start turns in that same thread, while replies and approval requests return to the chat. The local terminal remains available.

This skill applies only to Codex and is maintained in `skills/codex-bridge/`. Claude Code, OpenCode, and Pi continue to use their respective launch commands.

Install the skill:

```bash
node "$(npm root -g)/cli-wechat-bridge/skills/codex-bridge/scripts/install.mjs"
```

From a source checkout, run `node skills/codex-bridge/scripts/install.mjs`. The destination is `${CODEX_HOME:-~/.codex}/skills/codex-bridge`.

### Usage

Invoke `$codex-bridge` inside a Codex TUI session and name the channel. The skill runs the command below in the project directory for you; you normally do not run it by hand, and it is listed here for troubleshooting:

```bash
<channel>-codex --attach-current-session           # prefix selects the channel: wechat | wecom | telegram
<channel>-codex --attach-current-session --codex-thread-id <thread-id>
```

The command adds the session to the bridge daemon as a Codex instance without opening another window. If no daemon is running, it starts one in the background. Successful attachment prints `Attached Codex daemon thread <id>`.

The session counts as a Codex window when determining the bridge mode. It receives an instance number such as `codex-2` when another Codex window is already open in the same directory. Alongside another CLI type, it uses multi-CLI mode and follows that mode's one-instance-per-type rule. Attaching in another directory enables multi-workspace mode. Use `/resume` to switch to another thread in the same directory. To stop the entire bridge daemon, send `/daemon-stop` from the chat.

### How it works

- Codex >= 0.162 hosts its app-server in a shared background daemon by default (`~/.codex/app-server-control/app-server-control.sock`, WebSocket JSON-RPC, same-user connections).
- The bridge connects over that socket, discovers live sessions via `thread/list` (cwd filter + `status != notLoaded`), and rejoins the running thread with `thread/resume`: history plus a live event subscription, without taking the rollout writer lock from the owning client.
- Channel input is injected with `turn/start` on the same thread; the request **omits** approvalPolicy/sandbox overrides and fully inherits the session's own settings, so the shared thread configuration is never rewritten. Approvals, `request_user_input`, model switching, and interrupts reuse the existing bridge logic.

### Scope and limitations

- **Embedded sessions cannot be attached**: desktop-app (Codex Desktop), `--no-daemon`, `--oss`, and `--profile` sessions run an embedded app-server outside the shared daemon; resuming them fails with `thread ... already has an active writer`.
- Codex versions before 0.162 do not provide the shared daemon socket required by attach mode. This does not restrict the standard `wechat-codex` workflow, which starts its own app-server; compatibility for that workflow is verified against the required protocol capabilities.
- The shared daemon inherits its environment when it starts. After a daemon restart, the bridge attempts to reconnect and rejoin the thread.
- When a `wechat-daemon`/`wecom-daemon`/`telegram-daemon` is running, attach joins it and appears as `codex (attached)` in the `/cd` list (multi-directory mode); a daemon of another channel must be stopped first.
- Attach mode does not automatically change the existing session's MCP configuration, so the CLI collaboration tools introduced in 1.5.0 are not configured automatically.

### Desktop session connection limits

The desktop app's Codex backend is a `codex app-server` child spawned by the ChatGPT host process **without `--listen`**, i.e. stdio mode: JSON-RPC flows only through private pipes between it and the desktop app. That process exposes no listening port and no path-bound Unix socket (the desktop's sole `~/.codex/ipc/ipc.sock` is the IDE-context channel serving `/ide` with open files and selections — not a control surface). There is therefore no attach surface for an external process, and since it also holds the rollout writer lock, resumes through the shared daemon necessarily fail.

Terminal sessions use the shared daemon by default in Codex 0.162 and later, providing the multi-client connection required here. Desktop attachment depends on upstream exposing an interface that external clients can connect to. The bridge does not currently offer a fallback that closes the desktop session and then resumes its thread under bridge control.
