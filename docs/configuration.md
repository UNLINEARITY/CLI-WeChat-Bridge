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

企业微信凭据和附件使用独立子目录：`~/.cli-bridge/wecom/account.json`、`~/.cli-bridge/wecom/inbound-attachments/` 和 `~/.cli-bridge/wecom/inbound-message-claims/`。Telegram 对应使用 `~/.cli-bridge/telegram/account.json`、`~/.cli-bridge/telegram/inbound-attachments/` 和 `~/.cli-bridge/telegram/inbound-message-claims/`。工作区状态、bridge lock、daemon endpoint 与 `bridge.log` 仍由各通道共用，从而保证同一工作区一次只有一个远程通道拥有本地 CLI。

可以通过 `CLI_BRIDGE_DATA_DIR` 覆盖。状态文件、日志和旧目录迁移说明见 [问题排查](troubleshooting.md#数据目录与状态文件)。

旧版 `CLAUDE_WECHAT_CHANNEL_DATA_DIR` 不再作为活动数据目录配置项；如旧环境中设置过该变量，它只会被视为一次性旧数据迁移来源。新的自定义目录请使用 `CLI_BRIDGE_DATA_DIR`。

## 界面语言

在微信、企业微信、Telegram 或本地通道中发送以下指令，即可切换 bridge 提示语言：

| 指令 | 行为 |
| --- | --- |
| `/lang` | 查看当前语言及切换方式 |
| `/lang zh` | 切换为中文 |
| `/lang en` | Switch bridge messages to English |

`/language` 是 `/lang` 的别名，也支持 `中文` / `chinese` 和 `英文` / `english`。无效参数只显示用法，不会发送给模型。

切换立即作用于当前 bridge / daemon；daemon 中全部已连接 CLI companion 同步更新桥接提示语言，后续启动的 CLI companion 也会继承。任务运行中或等待审批、回答时也可切换，不会中断任务或清除待处理请求。旧版 companion 无法热更新时会提示重启对应可见 CLI。

偏好保存到活动数据目录的 `language.json`（默认 `~/.cli-bridge/language.json`），下次启动自动读取。多个独立运行的 bridge 不会自动热同步；它们在下次启动时读取保存值。

也可以在启动时通过 `CLI_BRIDGE_LANG` 指定语言：

```bash
# 中文
CLI_BRIDGE_LANG=zh wechat-daemon

# English
CLI_BRIDGE_LANG=en wechat-daemon
```

企业微信与 Telegram 使用相同变量，将命令换为 `wecom-daemon` 或 `telegram-daemon`；对应的直接启动命令也会继承该变量。

PowerShell 当前终端会话：

```powershell
$env:CLI_BRIDGE_LANG = "en"
wechat-daemon
```

启动优先级：有效的 `CLI_BRIDGE_LANG` > 已保存偏好 > 中文。显式设置的环境变量在每次重新启动时仍优先；运行中可用 `/lang` 再切换。直接启动命令若委托给已运行的 daemon，使用该 daemon 的当前语言。

语言设置覆盖 bridge 自身的模型 / 计划控制、状态、审批、问答、会话与通道提示。模型生成的回复、原始问题和选项、上游 CLI 界面及上游返回的错误文本保持原样；模型回复语言可通过提示词要求。

## 环境变量

| 变量名 | 说明 |
| --- | --- |
| `WECHAT_ILINK_BASE_URL` | 覆盖默认 iLink API 地址 |
| `CLI_BRIDGE_DATA_DIR` | 覆盖默认数据目录 |
| `CLI_BRIDGE_LANG` | 启动时的 bridge 文案语言；`zh` / `en`，优先于已保存偏好；运行中用 `/lang` 切换 |
| `WECOM_BOT_ID` | 覆盖 `wecom-setup` 保存的企业微信智能机器人 Bot ID |
| `WECOM_BOT_SECRET` | 覆盖 `wecom-setup` 保存的企业微信智能机器人 Secret |
| `WECOM_OPERATOR_USER_ID` | 覆盖已配对的企业微信操作者 userid |
| `TELEGRAM_BOT_TOKEN` | 设置或覆盖 BotFather 创建的 Bot Token；仅设置此项时仍需运行 `telegram-setup` 配对 |
| `TELEGRAM_OPERATOR_USER_ID` | 覆盖已配对操作者的数字 user ID，用于入站授权；不是 `@username` |
| `TELEGRAM_OPERATOR_CHAT_ID` | 覆盖操作者的私聊 chat ID，用于默认回复目标 |
| `TELEGRAM_BOT_USERNAME` | 可选，覆盖机器人用户名 |
| `WECOM_MAX_INBOUND_IMAGE_MB` | 覆盖企业微信入站图片下载限制，默认 20 MB |
| `WECOM_MAX_INBOUND_FILE_MB` | 覆盖企业微信入站文件下载限制，默认 50 MB |
| `WECOM_MAX_INBOUND_VIDEO_MB` | 覆盖企业微信入站视频下载限制，默认 50 MB |
| `WECHAT_MAX_IMAGE_MB` | 覆盖图片上传大小限制，默认 20 MB |
| `WECHAT_MAX_FILE_MB` | 覆盖普通文件上传大小限制，默认 50 MB |
| `WECHAT_MAX_VOICE_MB` | 覆盖语音上传大小限制，默认 20 MB |
| `WECHAT_MAX_VIDEO_MB` | 覆盖视频上传大小限制，默认 100 MB |
| `WECHAT_MAX_INBOUND_IMAGE_MB` | 覆盖微信入站图片下载大小限制，默认 20 MB |
| `WECHAT_MAX_INBOUND_FILE_MB` | 覆盖微信入站普通文件下载大小限制，默认 50 MB |
| `WECHAT_OPENCODE_DEBUG` | 开启 OpenCode 适配器调试输出 |
| `CLI_BRIDGE_STRICT_APPROVAL` | 设为 `1` 后默认关闭 bridge 对 Codex、Claude Code 和 OpenCode 的自动放行（运行中可用 `/auto on|off` 临时切换），并取消 Claude 启动设置中的 `WebFetch(domain:*)` 联网放行规则；支持远程处理的权限请求逐项等待 /confirm 或 /deny。Claude 沙箱网络弹窗不触发 PermissionRequest Hook，需要在本地终端处理 |
| `CLI_BRIDGE_SKIP_NODE_CHECK` | 设为 `1` 跳过入口命令的 Node.js >= 22.13.0 版本检查（自担风险） |

另外，桥接启动 `claude` / `codex` / `opencode` 子进程时会**完整继承当前终端的环境变量**（包括 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` 等），并自动为回环地址追加 `NO_PROXY`。如果你的 CLI 依赖环境变量认证，请确保在启动桥接的同一终端会话中设置了这些变量。

网络代理相关变量不是 CLI WeChat Bridge 专属配置。遇到 `wechat_send_failed`、`UND_ERR_CONNECT_TIMEOUT` 或 iLink 连接超时时，再检查 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`。Node 24+ 可设置 `NODE_USE_ENV_PROXY=1`；不要在 Node 22.13 中设置 `NODE_OPTIONS=--use-env-proxy`，该版本会在程序启动前拒绝此选项。具体排查步骤见 [问题排查](troubleshooting.md#wechat_send_failed-或-und_err_connect_timeout)。
