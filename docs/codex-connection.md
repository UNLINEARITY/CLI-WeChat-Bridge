# Codex 通道连接 skill(实验性)

## 中文

`codex-bridge` 是 Codex 专用的操作入口,源码位于 `skills/codex-bridge/`。它把**当前正在运行的 Codex 会话**接入微信通道:Bridge 以第二客户端身份加入 Codex 共享 app-server daemon,重新订阅(rejoin)当前会话的活线程——微信消息注入同一线程,回复与审批回传微信,本地 Codex 界面不受影响。Claude Code、OpenCode 和 Pi 继续使用各自现有的启动器,不属于这个 skill 的范围。

安装 skill:

```bash
node "$(npm root -g)/cli-wechat-bridge/skills/codex-bridge/scripts/install.mjs"
```

源码开发时,可直接运行 `node skills/codex-bridge/scripts/install.mjs`。安装目录为 `${CODEX_HOME:-~/.codex}/skills/codex-bridge`。

### 使用

在 Codex TUI 会话中调用 `$codex-bridge`,或在项目目录运行:

```bash
wechat-codex --attach-current-session            # 自动发现当前目录最新的活会话
wechat-codex --attach-current-session --codex-thread-id <thread-id>
```

命令在后台启动 attach bridge 并等待绑定完成,成功输出 `Attached Codex daemon thread <id>`。同一工作区重复执行会替换上一个 attach bridge。停止:微信发送 `/shutdown`,或结束持有 `~/.cli-bridge/bridge.lock.json` 的进程。

### 工作原理(已实测验证)

- Codex >= 0.162 默认把 app-server 托管在共享后台 daemon(`~/.codex/app-server-control/app-server-control.sock`,WebSocket JSON-RPC,同用户进程可连)。
- Bridge 通过该 socket 接入,用 `thread/list`(cwd 过滤 + `status != notLoaded`)发现活会话,再以 `thread/resume` **rejoin** 运行中的线程:拿到历史与实时事件订阅,不夺走原客户端的 rollout writer 锁。
- 微信消息经 `turn/start` 注入同一线程;参数**不带** approvalPolicy/sandbox 覆盖,完全继承该会话自身的设置,避免改写共享线程配置。审批、`request_user_input`、模型切换、中断沿用现有 bridge 逻辑。

### 边界(必须如实报告)

- **内嵌会话无法接入**:桌面 App(Codex Desktop)、`--no-daemon`、`--oss`、`--profile` 启动的会话内嵌 app-server,不在共享 daemon 里;对它们 resume 会得到 `thread ... already has an active writer`。
- codex < 0.162 没有共享 daemon socket,attach 模式不可用;原有 wechat-codex 自建 app-server 流程(验证范围 0.149–0.161)不受影响。
- 共享 daemon 的环境变量在 daemon 启动时固定;daemon 重启期间 Bridge 会自动重连并 rejoin。
- 同一工作区若有 `wechat-daemon`/`wecom-daemon` 在运行,它持有 bridge 锁,attach 会被拒绝;先停 daemon 或使用其多槽位。

### 为什么桌面会话无法接入(实证)

桌面 App 的 Codex 后端是一个由 ChatGPT 主进程拉起的 `codex app-server` 子进程,启动时**不带 `--listen`**,即 stdio 模式:JSON-RPC 只在它与桌面 App 之间的私有管道中流转。该进程没有任何监听端口,也没有路径绑定的 Unix socket(桌面 App 唯一暴露的 `~/.codex/ipc/ipc.sock` 属于 IDE 上下文通道,仅提供 `/ide` 所需的打开文件与选区信息,不是控制面)。因此外部进程不存在可连接的接入面;它同时持有 rollout 文件的 writer 锁,共享 daemon 侧的 resume 必然失败。

对比之下,终端 TUI 在 0.162+ 默认连接共享 daemon,天然具备多客户端接入能力。桌面会话若要支持附加,需要上游把桌面 App 迁移到共享 daemon(其 remote-management 流程正在朝此方向演进);届时本 bridge 的 attach 模式无需改动即可覆盖。"关闭桌面会话后由 bridge 冷 resume 接管该线程"的变通模式当前刻意未实现,以避免与"附加当前会话"的语义混淆。

## English

`codex-bridge` is a Codex-only entry point, maintained in `skills/codex-bridge/`. It attaches the **currently running Codex session** to WeChat: the bridge joins the shared Codex app-server daemon as a second client and rejoins the session's live thread — WeChat messages become turns in the same thread, replies and approvals return to WeChat, and the local Codex session keeps working unchanged. Claude Code, OpenCode, and Pi retain their existing launchers and are outside this skill's scope.

Install the skill:

```bash
node "$(npm root -g)/cli-wechat-bridge/skills/codex-bridge/scripts/install.mjs"
```

From a source checkout, run `node skills/codex-bridge/scripts/install.mjs`. The destination is `${CODEX_HOME:-~/.codex}/skills/codex-bridge`.

### Usage

Invoke `$codex-bridge` inside a Codex TUI session, or run from the project directory:

```bash
wechat-codex --attach-current-session            # discovers the newest live session in cwd
wechat-codex --attach-current-session --codex-thread-id <thread-id>
```

The command starts the attach bridge in the background and waits for the bind; success prints `Attached Codex daemon thread <id>`. Re-running it in the same workspace replaces the previous attach bridge. Stop with WeChat `/shutdown` or by ending the process holding `~/.cli-bridge/bridge.lock.json`.

### How it works (verified live)

- Codex >= 0.162 hosts its app-server in a shared background daemon by default (`~/.codex/app-server-control/app-server-control.sock`, WebSocket JSON-RPC, same-user connections).
- The bridge connects over that socket, discovers live sessions via `thread/list` (cwd filter + `status != notLoaded`), and rejoins the running thread with `thread/resume`: history plus a live event subscription, without taking the rollout writer lock from the owning client.
- WeChat input is injected with `turn/start` on the same thread; the request **omits** approvalPolicy/sandbox overrides and fully inherits the session's own settings, so the shared thread configuration is never rewritten. Approvals, `request_user_input`, model switching, and interrupts reuse the existing bridge logic.

### Boundaries (report honestly)

- **Embedded sessions cannot be attached**: desktop-app (Codex Desktop), `--no-daemon`, `--oss`, and `--profile` sessions run an embedded app-server outside the shared daemon; resuming them fails with `thread ... already has an active writer`.
- codex < 0.162 has no shared daemon socket, so attach mode is unavailable; the existing wechat-codex owned-app-server flow (validated 0.149–0.161) is unaffected.
- The daemon's environment is fixed at daemon start; the bridge reconnects and rejoins automatically across daemon restarts.
- If a `wechat-daemon`/`wecom-daemon` owns the workspace it holds the bridge lock and attach is refused; stop it first or use its multi-slot workflow.

### Why desktop sessions cannot be attached (verified)

The desktop app's Codex backend is a `codex app-server` child spawned by the ChatGPT host process **without `--listen`**, i.e. stdio mode: JSON-RPC flows only through private pipes between it and the desktop app. That process exposes no listening port and no path-bound Unix socket (the desktop's sole `~/.codex/ipc/ipc.sock` is the IDE-context channel serving `/ide` with open files and selections — not a control surface). There is therefore no attach surface for an external process, and since it also holds the rollout writer lock, resumes through the shared daemon necessarily fail.

Terminal TUIs, by contrast, attach to the shared daemon by default on 0.162+, which is what makes multi-client access possible. Supporting desktop attach requires upstream moving the desktop app onto the shared daemon (the direction its remote-management flow is already taking); when that happens this bridge's attach mode covers it with no changes. A workaround mode — cold-resuming the thread under the bridge after the desktop session closes — is deliberately not implemented, to keep it from being confused with attaching the live session.
