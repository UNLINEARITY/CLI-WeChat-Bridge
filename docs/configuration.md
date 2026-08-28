# 运行配置

CLI WeChat Bridge 的运行配置通过环境变量设置。使用 npm 全局安装的正式版本也可以直接设置这些变量，不需要从源码构建。

## 设置方式

PowerShell 当前终端会话：

```powershell
$env:CLI_BRIDGE_DATA_DIR = "D:\cli-bridge-data"
wechat-daemon
```

PowerShell 用户级持久配置：

```powershell
[Environment]::SetEnvironmentVariable("CLI_BRIDGE_DATA_DIR", "D:\cli-bridge-data", "User")
```

设置用户级变量后，需要重启终端和正在运行的 bridge / daemon。

Bash / zsh 当前命令：

```bash
CLI_BRIDGE_DATA_DIR=/path/to/cli-bridge-data wechat-daemon
```

## 数据目录

默认数据目录：

```text
~/.cli-bridge
```

可以通过 `CLI_BRIDGE_DATA_DIR` 覆盖。状态文件、日志和旧目录迁移说明见 [问题排查](troubleshooting.md#数据目录与状态文件)。

旧版 `CLAUDE_WECHAT_CHANNEL_DATA_DIR` 不再作为活动数据目录配置项；如旧环境中设置过该变量，它只会被视为一次性旧数据迁移来源。新的自定义目录请使用 `CLI_BRIDGE_DATA_DIR`。

## 环境变量

| 变量名 | 说明 |
| --- | --- |
| `WECHAT_ILINK_BASE_URL` | 覆盖默认 iLink API 地址 |
| `CLI_BRIDGE_DATA_DIR` | 覆盖默认数据目录 |
| `WECHAT_MAX_IMAGE_MB` | 覆盖图片上传大小限制，默认 20 MB |
| `WECHAT_MAX_FILE_MB` | 覆盖普通文件上传大小限制，默认 50 MB |
| `WECHAT_MAX_VOICE_MB` | 覆盖语音上传大小限制，默认 20 MB |
| `WECHAT_MAX_VIDEO_MB` | 覆盖视频上传大小限制，默认 100 MB |
| `WECHAT_MAX_INBOUND_IMAGE_MB` | 覆盖微信入站图片下载大小限制，默认 20 MB |
| `WECHAT_MAX_INBOUND_FILE_MB` | 覆盖微信入站普通文件下载大小限制，默认 50 MB |
| `WECHAT_OPENCODE_DEBUG` | 开启 OpenCode 适配器调试输出 |
| `CLI_BRIDGE_STRICT_APPROVAL` | 设为 `1` 后关闭所有自动审批，Claude/Codex 的每个权限请求都会转发到微信等待 /confirm 或 /deny |
| `CLI_BRIDGE_SKIP_NODE_CHECK` | 设为 `1` 跳过入口命令的 Node.js >= 22.13.0 版本检查（自担风险） |

另外，桥接启动 `claude` / `codex` / `opencode` 子进程时会**完整继承当前终端的环境变量**（包括 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` 等），并自动为回环地址追加 `NO_PROXY`。如果你的 CLI 依赖环境变量认证，请确保在启动桥接的同一终端会话中设置了这些变量。

网络代理相关变量不是 CLI WeChat Bridge 专属配置。遇到 `wechat_send_failed`、`UND_ERR_CONNECT_TIMEOUT` 或 iLink 连接超时时，再检查 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 和 `NODE_OPTIONS=--use-env-proxy`，具体排查步骤见 [问题排查](troubleshooting.md#wechat_send_failed-或-und_err_connect_timeout)。
