# CLI WeChat Bridge 版本发布说明

本目录包含 CLI WeChat Bridge 所有已发布版本的详细说明。

## 版本列表

### [v1.1.2](./1.1.2.md) / [中文说明](./1.1.2_CN.md)
**跨平台安装修复 + 崩溃/竞态加固 + 原子持久化 + 环境变量与诊断增强 + 基于 npm 的更新检查 + 三平台 CI** - 修复 node-pty 在 macOS/Linux 因 spawn-helper 缺执行位导致的静默 PTY fallback；为 adapter 加入 turn 完成竞态守卫和 spawn 错误处理；共享状态原子写入、入站去重 fail-closed、bridge.log 限长；恢复被过严白名单丢弃的 Windows 环境变量（ANTHROPIC_BASE_URL/OPENAI_API_KEY）；check-update 改查 npm registry；新增 Ubuntu/macOS/Windows 三平台 CI 质量门禁
- **跨平台安装**：postinstall 恢复 node-pty spawn-helper 执行位（修复 macOS/Linux posix_spawnp 失败的静默 fallback），并纳入 published files（修复全局安装 MODULE_NOT_FOUND）
- **崩溃与竞态**：OpenCode 单调 turn token 防陈旧完成覆盖、Codex app-server spawn 错误处理、Claude invalid-resume 捕获、PTY fallback spawn/stdin 错误处理、POSIX 进程树 pgrep 后代清理
- **持久化与去重**：context_tokens/bridge-state/bridge-lock 原子写入、入站 claim fail-closed、claim 清理基于 readdir 快照、bridge.log appendBoundedLog 5 MiB 上限、update-check setTimeout unref
- **环境与消息**：Windows 传完整 process.env（恢复 ANTHROPIC_BASE_URL/OPENAI_API_KEY）、消息 grace 窗口 5s→30s、长回复 1200 字符分段、附件路径平台无关化、doctor 时钟偏差/代码页/代理检查、CLI_BRIDGE_STRICT_APPROVAL 严格审批
- **更新检查**：wechat-check-update 改查 npm registry + GitHub tags API，全局安装可用；process.exit→process.exitCode 修复 Windows+Node24 的 UV_HANDLE_CLOSING 崩溃
- **CI**：GitHub Actions 三平台质量门禁、双语 PR 模板、bun install 缓存、README CI 徽章
- **统计**：36 个文件，新增 1,182 行，删除 159 行

### [v1.1.1](./1.1.1.md) / [中文说明](./1.1.1_CN.md)
**按适配器收敛的 doctor 诊断 + 紧凑 i18n 输出 + 架构/PTY 排障文档** - `wechat-daemon --doctor` 保持 daemon 全局检查，独立桥接 `--doctor` 只检查对应 adapter，shell 模式不再列出无关 CLI；doctor 输出默认中文，`CLI_BRIDGE_LANG=en` 切换为纯英文，并用更紧凑的字段格式展示 bridge lock、endpoint、数据目录和凭据状态
- **doctor 诊断**：覆盖 Node.js、Windows build、`node-pty`、adapter 命令、daemon endpoint、bridge lock、workspace companion endpoint、旧 endpoint、数据目录和凭据
- **输出格式**：运行时状态拆成可扫描字段，bridge lock 详情不再挤在单行里，也不再中英文混排
- **文档补充**：新增通信架构说明，扩展 PTY 平台前置条件、fallback 行为和 `wechat-daemon --doctor` 验证路径
- **统计**：12 个文件，新增 1,706 行，删除 8 行

### [v1.1.0](./1.1.0.md) / [中文说明](./1.1.0_CN.md)
**i18n 中文默认 + Claude 思考转发 + 自动批准修复 + 批量审批 + 单桥 emoji 绑定** - 引入轻量级国际化系统（默认中文，`CLI_BRIDGE_LANG=en` 切英文）；新增 Claude 思考过程实时转发到微信；修复自动批准 TCP 响应丢失导致 Claude 卡死的严重 bug；队列化批量审批替代单值存储；单桥模式支持 emoji 绑定命令
- **i18n**：`t(key, params?)` 查找函数 + 中英文消息目录，覆盖欢迎消息、hook 警告、PTY fallback、spawn 诊断、emoji binding 管理
- **Claude 思考转发**：800ms 轮询 transcript JSONL，提取 thinking 块以"思考:"前缀转发微信，默认关闭
- **自动批准修复**：TCP 响应丢失时回退到微信手动审批，防止 Claude 卡在终端权限提示
- **批量审批**：`/confirm`、`/yes` 一次确认所有待审批，bare text 命令对所有 adapter 生效
- **单桥 emoji 绑定**：`/bind`、`/unbind`、`/bindings` 在单桥模式可用，启动欢迎消息
- **进程树清理**：Windows 上 `killProcessTreeSync` 递归杀 Codex 子进程
- **跨平台诊断**：hook stderr 日志化、15s 健康检查、PTY fallback
- **统计**：26 个文件，新增 922 行，删除 206 行

### [v1.0.9](./1.0.9.md) / [中文说明](./1.0.9_CN.md)
**微信表情绑定 + 运行时 bug 修复 + macOS/Linux 可见终端 + 协议变更** - 新增表情到命令映射系统，支持默认绑定和微信内动态管理；修复 Stop 后无法恢复、图片无法读取、daemon 接管丢失会话等运行时 bug；为 macOS 和 Linux 添加可见终端窗口支持；协议从 MIT 变更为 AGPL-3.0 + 商业双协议
- **表情绑定**：发送微信表情即可触发 daemon 命令，默认映射 `[OK]→/confirm`、`[闭嘴]→/stop`、`[拥抱]→/claude`、`[强]→/codex`、`[胜利]→/opencode`、`[再见]→/daemon-stop`
- **绑定管理**：微信内 `/bindings`、`/bind [表情] /命令`、`/unbind [表情]` 动态管理，持久化到 JSON 文件
- **表情+文本**：表情后跟文本时先切换 adapter 再转发剩余文本（如 `[拥抱]帮我写个脚本` → 切到 Claude 并发送"帮我写个脚本"）
- **Stop 恢复**：Claude interrupt 添加 1.5s 回退超时，防止 adapter 永久卡在 busy
- **图片读取**：附件提示改为 ACTION REQUIRED 语言，强制 Claude Read 图片
- **会话保留**：daemon 接管同 adapter 时使用 restore 模式保留对话
- **进程安全**：POSIX 进程组终止、PTY 退出等待、信号防重入、RPC 超时、IPC 限流、增量日志读取
- **可见终端**：macOS 用 osascript + Terminal.app，Linux 检测终端模拟器，Windows 不变
- **统计**：6 个文件，新增约 300 行

### [v1.0.7](./1.0.7.md) / [中文说明](./1.0.7_CN.md)
**daemon 切换可靠性 + fresh session 启动 + 文档拆分** - 修复可见 CLI 连接失败后污染 active adapter 的问题，Codex endpoint 丢失后可重新发布并恢复连接，daemon 启动会清理同工作区残留 peer，同时 Claude Code / OpenCode 启动器默认进入 fresh session
- **daemon 切换保护**：`/codex`、`/claude`、`/opencode` 只有在可见 CLI 成功连接后才会激活目标 adapter；失败时保留原 active adapter 并记录 `activated`、`previous_active` 和 `session_start_mode`
- **Codex 可见端重连**：复用已有 Codex slot 前会重新发布 local companion endpoint，避免 endpoint 文件被删除后 remote client 直接退出
- **daemon 启动清理**：即使 `daemon-endpoint.json` 缺失或 pid 指错，也会扫描并清理同 cwd 的 `wechat-daemon` peer 进程
- **fresh session 默认值**：`wechat-claude-start`、`wechat-opencode-start` 和 daemon 新建 Claude/OpenCode slot 默认创建新会话，避免误恢复旧 session
- **Claude / OpenCode 启动细节**：Claude 自动处理 workspace trust prompt；OpenCode attach 会携带目录和 active session route，并重试 TUI session 选择
- **代码与文档清理**：删除旧 standalone Claude bot、旧 Codex panel IPC 和未使用 media transport，移除过期依赖，新增 `CONTRIBUTING.md`，并把配置、排查、开发说明拆分到独立文档
- **统计**：34 个文件，新增 2,175 行，删除 1,371 行

### [v1.0.6](./1.0.6.md) / [中文说明](./1.0.6_CN.md)
**审批体验 + 微信附件发送保护** - 低风险 Codex / Claude 查找读取操作自动通过，高风险操作继续进入微信审批，并阻止 Claude、Codex、OpenCode 把待发送文件错误 staging 到 `.claude`、`.cli-bridge` 或 `outbound-attachments` 目录
- **Codex 审批链路**：命令、文件变更、权限请求和 `request_user_input` 现在由 bridge 接管，低风险自动通过，高风险转发到微信，追问可用 `/answer` 回复
- **Claude 低风险自动通过**：`find`、`ls`、`grep`、`Get-ChildItem` 等读取查找命令以及 `Read`、`LS`、`Glob`、`Grep` 等只读工具不再反复触发审批
- **删除仍需审批**：高风险检测补充普通 `rm`、`find -delete`、`find -exec rm` 和 `xargs rm`
- **附件发送保护**：所有 adapter 都会拒绝错误的 outbound attachment staging；OpenCode 额外覆盖 `metadata.filepath`、`metadata.parentDir` 和 `external_directory` 权限形态
- **Claude 多行 prompt**：使用 bracketed paste 和延迟 Enter，确保微信附件提示完整送达 Claude 可见终端
- **统计**：15 个文件，新增 2,739 行，删除 132 行

### [v1.0.5](./1.0.5.md) / [中文说明](./1.0.5_CN.md)
**常驻 daemon + 短 npm 包名 + `.cli-bridge` 自动迁移** - 新增 `wechat-daemon`，支持从微信在 Codex、Claude Code 与 OpenCode 之间切换并自动打开或复用可见 CLI，同时启用 `cli-wechat-bridge` 主包名并把运行数据迁移到独立的 `~/.cli-bridge` 目录
- **常驻 daemon**：`wechat-daemon` 绑定当前工作区，微信发送 `/codex`、`/claude`、`/opencode` 即可切换活动 CLI；切换不会关闭之前的 CLI slot
- **短包名发布**：`cli-wechat-bridge` 成为默认 npm 安装入口，`@unlinearity/cli-wechat-bridge` 作为兼容镜像继续同步
- **自动打开可见 CLI**：daemon 会复用已有 companion；没有目标 CLI 时自动打开本地可见终端，并等待连接结果
- **迁移与清理**：老用户数据会从旧 Claude channel 路径迁移到 `~/.cli-bridge`，旧 lock 不迁移，启动 daemon 前会清理旧单 bridge 状态
- **入站附件**：微信收到的图片和普通文件会保存到 `~/.cli-bridge/inbound-attachments/<日期>/`，并把本地路径加入转发给 CLI 的 prompt
- **context 诊断**：`sendmessage ret=-2` 会被识别为微信 context token 过期，日志会标明失败场景并提示先让微信端发一条新消息
- **统计**：32 个文件，新增 4,703 行，删除 178 行

### [v1.0.4](./1.0.4.md) / [中文说明](./1.0.4_CN.md)
**桥接回复可靠性 + 真实全局安装烟测 + 源码质量门禁** - 修复 OpenCode/Codex 回复回传边界，补上 lint/typecheck/quality 基础设施，并让本地构建包可以安装到真实 npm 全局环境做人工验证
- **OpenCode 回复正确性**：最终回复改为优先取 session 中最新可见 assistant 内容，过滤 reasoning delta 与 prompt 回显，并保留长回复整段发送体验
- **Codex 启动隔离**：shared session 只在同 adapter、同工作区恢复，避免 OpenCode `ses_...` 串入 Codex，并阻止启动时历史本地 session 内容回放到微信
- **源码质量门禁**：新增 ESLint flat config、`typecheck:src` 和 `quality`，让 lint、源代码 TS 检查、测试与 build 形成统一发布前验证
- **真实全局烟测**：`npm run smoke:global` 现在用当前源码打 tarball，再 `npm install -g` 到真实全局 prefix，并从用户主目录验证 `wechat-*` shim
- **README 刷新**：补齐 npm 安装、`wechat-setup`、单命令启动器、OpenCode 支持和手动双终端调试说明
- **统计**：36 个文件，新增 3,354 行，删除 1,009 行

### [v1.0.3](./1.0.3.md) / [中文说明](./1.0.3_CN.md)
**Codex 回复恢复 + OpenCode 新会话跟随** - 修复 Codex 已生成回答但未回传微信，以及 OpenCode 本地 `new` 后微信仍进入旧会话的问题
- **Codex final reply 恢复**：app-server 状态不健康时仍可从 session 日志恢复 `task_complete` 与 `final_reply`
- **OpenCode `/new`**：微信支持 `/new` / `/new-session`，并通过 companion 与 SDK 创建新 session
- **本地 OpenCode session 跟随**：兼容无目录 `global-event session.created` 与多种 session 字段形态
- **OpenCode 回复清洗**：防止 prompt 回显和同一行推理前缀污染微信回复
- **统计**：13 个文件，新增 849 行，删除 26 行

### [v1.0.2](./1.0.2.md) / [中文说明](./1.0.2_CN.md)
**npm 全局安装鉴权修复：首次扫码 + 过期会话恢复** - 全局 starter 命令现在会在前台处理缺失或过期的微信凭据
- **前台扫码登录**：`wechat-codex-start` / `wechat-claude-start` / `wechat-opencode-start` 在打开 companion 前验证微信凭据
- **过期会话恢复**：识别 `errcode=-14 session timeout`，清理旧同步游标并避免无限重试
- **legacy 状态清理**：删除全局 `account.json` 后，不再从 repo-local `~\.claude` 复活旧凭据
- **setup 输出精简**：新增 `wechat-setup` 全局命令，登录成功提示不再输出 repo-local `bun run ...` 指南
- **统计**：12 个文件，新增 511 行，删除 126 行

### [v1.0.0](./1.0.0.md) / [中文说明](./1.0.0_CN.md)
**稳定版与 npm 上架准备：多适配器 companion + Codex 隔离 + Windows 可靠性** - Codex、Claude、OpenCode 与 shell 工作流进入稳定发布节奏

- **多适配器 companion**：OpenCode 进入主工作流，新增 `wechat-bridge-opencode` / `wechat-opencode` / `wechat-opencode-start`
- **Codex 隔离与单活工作区**：`wechat-codex` 使用 bridge-owned runtime host，fallback session 与桌面端流量隔离，starter 按单活工作区切换器工作
- **Windows 可靠性**：保留代理环境变量、消除启动闪窗、固定 CLI 入口行尾，并改善 transient companion 断开处理
- **消息与附件修复**：Codex 忙碌时延迟投递微信消息，Claude final reply 可回退 transcript，中文附件发送提示词覆盖更完整
- **统计**：61 个文件，新增 12,252 行

### [v0.9.0](./0.9.0.md) / [中文说明](./0.9.0_CN.md)
**工作流与可靠性版本：一键启动 + 生命周期治理 + 附件与状态同步修复** - 本地 companion 启动更简单，bridge 退出与远程执行更可靠

- **一键 companion 启动**：新增 `wechat-codex-start` / `wechat-claude-start`，自动拉起或复用当前目录 bridge，等待 endpoint 后打开可见 companion
- **生命周期治理**：新增 `companion_bound` lifecycle、父进程退出监听、孤儿 lock 自动回收，关闭 companion 后可自动停止临时 bridge
- **Shell 与附件改进**：shell 模式明确为非交互远程执行器；附件提示只在真实“发到微信”请求时注入，并恢复普通本地文件自动发送
- **Claude / Codex 稳定性**：Claude `/compact` 完成与失败状态可同步到微信；Codex panel 正常退出不再留下悬挂 bridge 或误报 fatal error
- **统计**：43 个文件，新增 5,515 行

### [v0.8.0](./0.8.0.md) / [中文说明](./0.8.0_CN.md) 
**重大版本：版本检查 + 媒体支持 + 可靠性** - 三大功能集提升可靠性、功能性和可维护性

- **版本检查与自动更新**：基于 Git 的版本检测，24 小时缓存，手动 `wechat-check-update` 命令，无 API 速率限制
- **媒体发送**：全面支持图片、文件、语音、视频，双队列架构，附件解析，大小限制
- **网络可靠性**：传输错误分类，指数退避重试，详细错误日志
- **统计**：18 个文件，新增 2,196 行

### [v0.7.0](./0.7.0.md) / [中文说明](./0.7.0_CN.md)
**Claude 远程审批** - 完整的 Claude 远程审批流程，改进微信审批消息格式

- Claude Code 权限请求完整集成
- 工具特定格式的结构化审批消息
- 计划摘要提升可读性
- 完整的基于 hook 的审批工作流

### [v0.6.0](./0.6.0.md) / [中文说明](./0.6.0_CN.md)
**导入修复** - 恢复适配器重构后丢失的导入

### [v0.5.0](./0.5.0.md) / [中文说明](./0.5.0_CN.md)
**重大版本：Claude Companion + 跨平台 + 会话统一** - 架构演进的变革性版本

- **Claude Code Companion**：原生双终端 Claude 工作流，与 Codex 完全一致，hook 中继系统，远程审批
- **统一会话语义**：从线程特定迁移到会话感知架构，适配器中性术语
- **跨平台支持**：一等 Linux 和 macOS 支持，POSIX shell 支持（bash、zsh、sh），平台感知 shell 检测
- **状态管理修复**：自动恢复残留活跃 turn，修复 Codex 忙碌状态持久化
- **统计**：25 个文件，新增 3,595 行

### [v0.4.0](./0.4.0.md) / [中文说明](./0.4.0_CN.md)
**可靠性修复** - Codex 面板连接和线程切换修复

- 面板连接自动重连
- 修复本地输入重复镜像
- 线程切换历史抑制
- 忙碌状态恢复改进

### [v0.3.0](./0.3.0.md) / [中文说明](./0.3.0_CN.md)
**全局命令** - 具有工作区隔离的全局命令

- 从任何目录运行桥接命令
- 工作区特定状态管理
- 简化安装和使用

### [v0.2.0](./0.2.0.md) / [中文说明](./0.2.0_CN.md)
**原生重新设计** - 原生 Codex 终端体验重新设计

- 双终端模式的完整架构重新设计
- 原生 TUI 面板，完整 Codex 功能
- 通过结构化 websocket API 的清晰最终回复
- 简化授权模型

## 版本历史

| 版本 | 日期 | 说明 | 文件变更 |
|------|------|------|---------|
| 1.1.2 | 2026-07-07 | node-pty 跨平台执行位修复、崩溃/turn 竞态加固、原子持久化与入站 fail-closed 去重、Windows 环境变量与诊断增强、npm-based 更新检查、三平台 CI 质量门禁 | 36 个文件，+1,182/-159 |
| 1.1.1 | 2026-06-02 | 按适配器收敛的 doctor 诊断、紧凑 i18n 输出、bridge lock 字段化展示、架构文档与 PTY 排障补充 | 12 个文件，+1,706/-8 |
| 1.1.0 | 2026-05-27 | i18n 中文默认、Claude 思考转发、自动批准修复、批量审批、单桥 emoji 绑定、进程树清理、跨平台诊断 | 26 个文件，+922/-206 |
| 1.0.9 | 2026-05-26 | 微信表情绑定、Stop 恢复、图片读取、daemon 会话保留、进程安全、macOS/Linux 可见终端、协议变更为 AGPL-3.0 双协议 | 6 个文件，+300 |
| 1.0.7 | 2026-05-26 | daemon 切换失败不再污染 active adapter，Codex endpoint 丢失可恢复，旧 daemon peer 自动清理，Claude/OpenCode 默认 fresh session，文档拆分与旧代码清理 | 34 个文件，+2,175/-1,371 |
| 1.0.6 | 2026-05-23 | Codex / Claude 低风险审批自动通过、微信附件发送 staging 保护、Codex `/answer` 用户输入回传 | 15 个文件，+2,739/-132 |
| 1.0.5 | 2026-05-22 | 常驻 daemon、多 CLI 微信切换、短 npm 包名、`.cli-bridge` 自动迁移、入站附件落盘与 stale context token 诊断 | 32 个文件，+4,703/-178 |
| 1.0.4 | 2026-05-16 | 桥接回复可靠性、源码质量门禁、真实全局 npm 安装烟测与 README 工作流刷新 | 36 个文件，+3,354/-1,009 |
| 1.0.3 | 2026-05-11 | Codex final reply 恢复、OpenCode `/new` 与本地新会话跟随修复 | 13 个文件，+849/-26 |
| 1.0.2 | 2026-05-11 | npm 全局安装后的微信首次鉴权、过期会话恢复与 setup 提示修复 | 12 个文件，+511/-126 |
| 1.0.0 | 2026-05-10 | 稳定版、npm 上架准备、多适配器 companion、Codex 隔离与 Windows 可靠性 | 61 个文件，+12,252/-423 |
| 0.9.0 | 2026-03-27 | 一键启动、生命周期治理、附件与状态同步修复 | 43 个文件，+5,515/-154 |
| 0.8.0 | 2026-03-26 | 版本检查、媒体支持、网络可靠性 | 18 个文件，+2,196/-505 |
| 0.7.0 | 2026-03-25 | 完整 Claude 远程审批流程 | 15 个文件，+494/-62 |
| 0.6.0 | 2026-03-24 | 项目重组和导入修复 | 40 个文件，+5,836/-5,538 |
| 0.5.0 | 2026-03-24 | Claude companion、跨平台、会话统一 | 25 个文件，+3,595/-289 |
| 0.4.0 | 2026-03-23 | Codex 面板连接和线程切换修复 | 11 个文件，+714/-122 |
| 0.3.0 | 2026-03-22 | 具有工作区隔离的全局命令 | 21 个文件，+2,707/-334 |
| 0.2.0 | 2026-03-20 | 原生 Codex 终端重新设计 | 多个文件 |
