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

Codex、Claude Code 等适配器会在 bridge 能识别的审批请求上同步到微信侧处理。少数底层 CLI 自己弹出的本地 TUI 安全确认，如果没有暴露给 bridge，仍可能需要在本地终端处理。

如果普通查找、读目录、读文件等低风险命令频繁要求本地终端审批，请保留 `bridge.log` 和对应终端输出后提交 issue。

## 已知限制

- 微信侧 `/resume` 暂时禁用，以避免远程和本地会话线程出现不一致。
- `wechat-daemon` v1 绑定启动工作区，暂不支持从微信切换到另一个本地目录。
- 入站图片和文件会保存为本地路径并转发给 CLI；bridge 本身不做 OCR，也不自动抽取 PDF / DOCX 正文。
- daemon 和独立 bridge 不应在同一工作区同时运行；同目录启动器会优先委托已有 daemon。
