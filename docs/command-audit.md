# CLI WeChat Bridge 指令、入口与协议审计

> 审计日期：2026-08-22
> 审计基线：`cli-wechat-bridge` 1.1.3 及当前 `main`
> 文档用途：核查哪些入口属于核心功能、兼容入口、高级调试、历史遗留、可选便利层或内部协议。
> 重要：本文同时记录审计事实和已经确认的命令面决策；未列入“已确认决策”的候选项仍不代表授权删除。

## 1. 审计范围

本次审计覆盖以下七类“指令”：

1. 发布到 npm 的全局 CLI 命令；
2. 各 CLI 家族支持的参数和隐藏参数；
3. 微信中由 bridge 或 daemon 拦截的斜杠命令、审批别名和普通文本行为；
4. 微信 emoji 默认映射及绑定管理命令；
5. `package.json` 中的 npm 开发、测试、构建和发布脚本；
6. 源码模式 MCP server 暴露的 WeChat 工具；
7. daemon、local companion、Pi extension 以及各上游 adapter 的内部协议命令。

以下内容不逐项枚举：

- Codex、Claude Code、OpenCode、Pi 自身的全部原生命令和模型参数；starter 与 companion 会把未知参数透传给这些 CLI。
- PowerShell、Bash 等 shell 自身的内建命令。
- 环境变量配置；它们属于配置面，不属于本次“指令面”审计。

## 2. 评级定义

| 评级 | 含义 | 当前动作建议 |
| --- | --- | --- |
| 核心保留 | 首选用户流程、登录、状态、停止、审批或主要 adapter 选择所必需 | 不删除；修改需要完整兼容评估 |
| 高级保留 | 不属于首选流程，但承担调试、恢复、手动连接或高级配置 | 保留实现，可从主文档降级到高级章节 |
| 兼容保留 | 与首选流程有重叠，但支持旧工作流或无 daemon 场景 | 先收集使用情况，再决定长期弃用 |
| 候选隐藏 | 当前仍有防误转发、诊断或兼容价值，但不应作为推荐命令展示 | 保留拦截或实现，减少公开曝光 |
| 候选合并/重命名 | 功能仍有价值，但入口重复、名称不准确或组织方式不一致 | 先提供替代名称和迁移周期 |
| 候选废弃 | 与主流程高度重叠、长期无用户或只保留历史实现 | 必须先确认真实使用量并提供弃用期 |
| 内部勿动 | 进程间协议、adapter RPC、hook 或事件名称 | 不应按用户命令数量进行清理 |
| 待确认 | 仅凭代码无法确认是否仍有外部使用者 | 需要用户反馈、下载数据或实际调用证据 |

## 3. 总览

| 类别 | 数量 | 主要重叠或风险 |
| --- | ---: | --- |
| npm 全局 CLI | 11（过渡版本） | 四个直接命令、四个弃用 aliases、daemon、setup、update-check |
| 全局 CLI 内部包装器 | 1 | `_run-entry.mjs` 是所有发布命令共用的 Node 入口，不是用户命令 |
| 微信斜杠命令与斜杠别名 | 19 | `/resume` 当前没有可执行路径；审批和会话命令存在多个别名 |
| 审批 bare-text 别名 | 4 | 仅有待审批时拦截 `confirm`、`yes`、`deny`、`no` |
| 默认 emoji 映射 | 6 | 缺少 Pi；`[再见]` 直接停止 daemon，误触影响最大 |
| npm scripts | 33 | Shell script 已删除；源码模式仍有命名与重复项待后续审计 |
| MCP tools | 9 | 整体属于次要/历史 MCP 工作流，与当前 daemon/bridge 产品面并存 |
| daemon IPC 命令 | 4 | 全部为内部协议，不是公开命令 |
| local companion 请求 | 10 | 全部为 bridge 与可见 CLI 之间的内部协议 |
| Pi extension 请求 | 4 | 全部为 Pi 原生 TUI bridge 的内部协议 |

## 4. 已确认的命令面决策

| 项目 | 已确认决策 | 兼容策略 |
| --- | --- | --- |
| 四个直接命令 | `wechat-codex`、`wechat-claude`、`wechat-opencode`、`wechat-pi` 成为智能启动器 | 无 daemon 时创建内部 runtime；有 daemon 时委托 |
| 四个 `*-start` | 暂时与直接命令功能一致 | 输出弃用提示，保留一个版本，下一版本删除 |
| 全部 `wechat-bridge*` | 从 npm bin 和 `bin/` 立即删除 | 内部 `wechat-bridge.ts` runtime 继续存在 |
| 手动双终端用户流程 | 删除 | 维护者仍可使用源码 `bridge:*` 与 companion scripts 调试 |
| Shell adapter | 完整删除 | 旧 shell lock/endpoint 只保留 legacy 读取和清理 |
| 默认会话 | Codex restore；Claude、OpenCode、Pi new | 沿用已验证的 starter 行为 |

## 5. 过渡版本公开 CLI

过渡版本从原来的 17 个 npm bin 收敛为 11 个。

| 命令 | 状态 | 行为 | 后续 |
| --- | --- | --- | --- |
| `wechat-setup` | 核心保留 | 登录或刷新 WeChat 凭据 | 长期保留 |
| `wechat-daemon` | 核心保留 | 常驻微信连接和四 adapter slots | 长期保留 |
| `wechat-check-update` | 本批不调整 | 手动检查版本 | 留待后续审计 |
| `wechat-codex` | 新主入口 | 智能确保 runtime；Codex 默认恢复 | 长期保留 |
| `wechat-claude` | 新主入口 | 智能确保 runtime；Claude 默认新会话 | 长期保留 |
| `wechat-opencode` | 新主入口 | 智能确保 runtime；OpenCode 默认新会话 | 长期保留 |
| `wechat-pi` | 新主入口 | 智能确保 runtime；Pi 默认新会话 | 长期保留 |
| `wechat-codex-start` | 弃用 alias | 与 `wechat-codex` 完全相同，并输出提示 | 下一版本删除 |
| `wechat-claude-start` | 弃用 alias | 与 `wechat-claude` 完全相同，并输出提示 | 下一版本删除 |
| `wechat-opencode-start` | 弃用 alias | 与 `wechat-opencode` 完全相同，并输出提示 | 下一版本删除 |
| `wechat-pi-start` | 弃用 alias | 与 `wechat-pi` 完全相同，并输出提示 | 下一版本删除 |

### 5.1 已删除的公共命令

| 命令 | 删除原因 | 内部替代 |
| --- | --- | --- |
| `wechat-bridge` | 通用公开入口增加认知成本，用户不应手动选择内部 adapter runtime | `npm run bridge -- --adapter ...` 仅供维护者 |
| `wechat-bridge-codex` | 手动双终端流程被智能 `wechat-codex` 替代 | 内部 transient bridge |
| `wechat-bridge-claude` | 同上 | 内部 transient bridge |
| `wechat-bridge-opencode` | 同上 | 内部 transient bridge |
| `wechat-bridge-pi` | 同上 | 内部 transient bridge |
| `wechat-bridge-shell` | Shell adapter 整体退出产品范围 | 无公开替代 |

### 5.2 当前运行模型

| 模型 | 用户入口 | 内部行为 |
| --- | --- | --- |
| 常驻 daemon | `wechat-daemon` | 一个微信连接管理四个 adapter slot，并自动打开或复用可见 CLI |
| 直接启动 | 四个 `wechat-*` | 优先委托同 cwd daemon；否则启动 companion-bound transient bridge，再打开可见 CLI |
| 维护者调试 | `npm run bridge:*` 与 companion scripts | 直接观察 bridge/companion IPC，不属于发布的用户命令 |

`bin/_run-entry.mjs` 仍是所有发布命令共用的 Node wrapper，不是用户指令；它同时负责 `*-start` alias 的统一弃用提示。

## 6. CLI 参数审计

### 6.1 四个直接命令

适用：`wechat-codex`、`wechat-claude`、`wechat-opencode`、`wechat-pi`，以及过渡期对应的 `*-start` aliases。

| 参数 | 行为 | 评级 |
| --- | --- | --- |
| `--cwd <path>` | 指定 runtime 与可见 CLI 的工作区 | 核心保留 |
| `--profile <name-or-path>` | 传递给内部 adapter runtime | 高级保留 |
| `--timeout-ms <ms>` | endpoint 等待上限，至少 1000 ms | 高级保留 |
| `--session-start-mode <restore\|new>` | 覆盖默认会话策略 | 高级保留 |
| `--doctor` | 只运行所选 adapter/workspace 的 doctor，不启动 CLI | 核心保留 |
| `--help`、`-h` | 输出直接命令 usage 和 alias 弃用说明 | 核心保留 |
| 其他未知参数 | 原样透传给可见底层 CLI | 必须保留 |

### 6.2 Daemon 参数

| 参数 | 行为 | 评级 |
| --- | --- | --- |
| `--cwd <path>` | 绑定 daemon 的唯一工作区 | 核心保留 |
| `--adapter <codex\|claude\|opencode\|pi>` | 启动后立即创建/激活初始 slot | 高级保留 |
| `--profile <name-or-path>` | 为初始 adapter 提供 profile | 高级保留 |
| `--no-open` | 创建 slot 但不自动打开可见 CLI | 高级调试保留 |
| `--doctor` | 对 daemon、四个 adapter、锁和 endpoint 做诊断 | 核心保留 |
| `--help`、`-h` | 输出 usage | 核心保留 |

### 6.3 内部 bridge 参数

公开 `wechat-bridge*` bins 已删除，但维护者仍可通过 npm scripts 启动内部 runtime。

| 参数 | 行为 | 公开程度 |
| --- | --- | --- |
| `--adapter <codex\|claude\|opencode\|pi>` | 选择内部 adapter runtime | 维护者内部 |
| `--cmd <executable>` | 覆盖 adapter 默认命令 | 维护者内部 |
| `--cwd <path>` | 指定工作区 | 维护者内部 |
| `--profile <name-or-path>` | 传递 profile | 维护者内部 |
| `--lifecycle <persistent\|companion_bound>` | 控制可见端退出后的 runtime 生命周期 | 维护者内部 |
| `--session-start-mode <restore\|new>` | 选择恢复或新会话 | 维护者内部 |
| `--shutdown-on-parent-exit` | legacy internal alias for companion-bound | 候选后续清理 |
| `--doctor` | 内部 bridge doctor | 维护者内部 |

### 6.4 Internal visible client 参数

Codex remote client 和 local companion 模块仍由 daemon、智能 launcher 及源码调试脚本使用，但不再对应“只连接已有 bridge”的公开 `wechat-*` 行为。

| 模块 | 内部参数 | 用途 |
| --- | --- | --- |
| Codex remote client | `--cwd` + Codex passthrough args | 连接 bridge-owned Codex app-server |
| Claude/OpenCode/Pi companion | `--adapter`、`--cwd`、`--session-start-mode` + passthrough args | 托管可见原生 CLI |
| smart launcher | `--adapter` | 由公开 wrapper 注入，不要求用户输入 |

### 6.5 没有独立参数面的命令

| 命令 | 当前参数行为 |
| --- | --- |
| `wechat-setup` | 没有公开参数；运行即检查现有凭据或扫码登录 |
| `wechat-check-update` | 没有公开参数；运行即查询版本 |

## 7. 微信侧命令审计

### 7.1 命令解析优先级

daemon 模式按以下顺序处理：

1. 校验消息发送者；
2. 解析消息开头的 emoji 绑定；
3. 解析 `/codex`、`/claude`、`/opencode`、`/pi` 及其行内 prompt；
4. 处理 `/daemon-stop`；
5. 处理 `/bind`、`/unbind`、`/bindings`；
6. 针对当前 active slot 处理 `/status`、`/resume`、`/new`、`/stop`、`/reset`、审批和 `/answer`；
7. 有待审批/待回答时返回 reminder；
8. 其余文本转发给当前 adapter。

standalone 模式按以下顺序处理：

1. 解析并重写 emoji；
2. 处理 emoji 绑定管理命令；
3. 处理通用 bridge 控制命令；
4. 处理待审批/待回答状态；
5. 其余内容转发给当前 adapter。

未知斜杠文本不会被统一拒绝，而会作为普通输入交给 adapter。这意味着删除一个拦截命令可能改变它的行为，而不是简单地让命令“消失”。

### 7.2 Adapter 切换命令

| 命令 | 模式 | 行为 | 重叠关系 | 初步评级 |
| --- | --- | --- | --- | --- |
| `/codex [prompt]` | daemon | 激活/复用 Codex；有 prompt 时只转发剩余文本 | 对应 `wechat-codex-start`，但这是微信远程切换 | 核心保留 |
| `/claude [prompt]` | daemon | 激活/复用 Claude Code；可立即转发 prompt | 同上 | 核心保留 |
| `/opencode [prompt]` | daemon | 激活/复用 OpenCode；可立即转发 prompt | 同上 | 核心保留 |
| `/pi [prompt]` | daemon | 激活/复用现有 Pi TUI；不会像 `wechat-pi-start` 那样强制新 session | 同上，但 fresh-session 语义不同 | 核心保留 |

在 standalone 模式中，这四个命令不是 bridge 控制命令，可能被当作普通文本或底层 CLI 命令转发。

### 7.3 通用控制命令

| 命令 | 支持模式 | 当前行为 | 容易混淆点 | 初步评级 |
| --- | --- | --- | --- | --- |
| 普通文本 | daemon、standalone | 转发给 active adapter；daemon 会先确保可见 CLI 存活 | 产品核心数据路径 | 核心保留 |
| `/status` | daemon、standalone | daemon 返回工作区、active adapter 和所有 slot；standalone 返回当前 bridge/adapter 状态 | 两种模式输出粒度不同 | 核心保留 |
| `/resume [target]` | daemon、standalone | daemon 一律提示在可见 CLI 内使用；standalone Codex/Claude/OpenCode 也提示禁用，Pi/shell 返回不可用 | parser 接受 target，但当前没有任何微信执行路径 | 候选隐藏；建议保留拦截提示，暂不直接删除 parser |
| `/new` | daemon、standalone | 调用 adapter `createSession()`；不支持时返回提示 | 与 `/reset` 容易混淆 | 高级保留 |
| `/new-session` | daemon、standalone | `/new` 的完全别名 | 增加命令面但语义清晰 | 候选合并；保留 `/new` 即可满足功能 |
| `/stop` | daemon、standalone | 中断当前 active turn；OpenCode 会先拒绝待回答 question | 与 emoji `[闭嘴]` 重叠 | 核心保留 |
| `/reset` | daemon、standalone | 清输出、审批和待回答状态并重置 worker/session | 比 `/new` 更强，可能重启/清理更多 runtime 状态 | 高级保留；文档需强调差异 |
| `/daemon-stop` | daemon | 发送确认文字后关闭 daemon 进程 | 与 `[再见]` 重叠；影响整个常驻服务 | 核心管理命令，但应减少误触入口 |

### 7.4 审批与用户输入命令

| 命令或文本 | 生效条件 | 当前行为 | 初步评级 |
| --- | --- | --- | --- |
| `/confirm` | 有无待审批都被识别 | standalone 处理当前审批；daemon 批量处理找到的 slot 审批 | 核心保留 |
| `/yes` | 同 `/confirm` | 完全别名 | 候选简化，但手机输入便利性高 |
| bare `confirm` | 仅在有待审批时 | 等价 `/confirm`；无审批时作为普通 prompt | 便利别名 |
| bare `yes` | 仅在有待审批时 | 等价 `/confirm` | 便利别名 |
| `/deny` | 有无待审批都被识别 | 拒绝当前或批量待审批 | 核心保留 |
| `/no` | 同 `/deny` | 完全别名 | 候选简化，但手机输入便利性高 |
| bare `deny` | 仅在有待审批时 | 等价 `/deny` | 便利别名 |
| bare `no` | 仅在有待审批时 | 等价 `/deny` | 便利别名 |
| `/answer <answer>` | 有待处理的结构化问题时 | 解析单选、多选、自定义回答并提交给 Codex/OpenCode 等 adapter | 核心保留 |

注意：当前 parser 对 `/confirm` 后面的参数不做一次性 code 校验；`/confirm ABC123` 与 `/confirm` 都会解析为相同的确认命令。一次性 code 目前主要出现在提示文本和旧兼容流程中。如果希望 code 真正承担授权校验，需要单独修复，而不是仅调整文档。

### 7.5 Emoji 绑定管理命令

| 命令 | 模式 | 行为 | 初步评级 |
| --- | --- | --- | --- |
| `/bindings` | daemon、standalone | 列出当前全部 emoji -> command 映射 | 可选便利层 |
| `/bind [emoji] command` | daemon、standalone | 新增或覆盖绑定；command 可包含余下文本 | 可选便利层 |
| `/unbind [emoji]` | daemon、standalone | 删除绑定 | 可选便利层 |

格式错误但以 `/bind` 或 `/unbind` 开头的消息会被拦截并返回 usage，不会转发给 adapter。

## 8. 默认 emoji 映射

| 默认 emoji 文本 | 映射命令 | 用途 | 风险/重叠 | 初步建议 |
| --- | --- | --- | --- | --- |
| `[OK]` | `/confirm` | 快速批准审批 | 与 `/confirm`、`/yes`、bare yes 重叠 | 可保留；审批高频时有价值 |
| `[闭嘴]` | `/stop` | 快速中断当前任务 | 普通表情可能误触，但只影响当前 turn | 可保留或改为用户自定义 |
| `[拥抱]` | `/claude` | 切换 Claude Code | 与斜杠切换重叠 | 可选便利层 |
| `[强]` | `/codex` | 切换 Codex | 与斜杠切换重叠 | 可选便利层 |
| `[胜利]` | `/opencode` | 切换 OpenCode | 与斜杠切换重叠 | 可选便利层 |
| `[再见]` | `/daemon-stop` | 停止常驻 daemon | 误触会终止整个服务，风险最高 | 建议优先核查是否移除默认绑定，但保留自定义能力 |

当前默认映射没有 Pi。若继续保留“默认 adapter emoji”概念，应决定是给 Pi 增加一致映射，还是取消所有默认 adapter 映射并只保留用户自定义。

绑定解析规则：

- 只有消息开头的绑定文本会触发；
- 大小写不敏感；
- emoji 后有余下文本时，先执行映射命令，再处理剩余文本；
- daemon 下的 adapter emoji 可实现“切换并立即转发”；
- 配置保存到 `~/.cli-bridge/emoji-bindings.json`。

## 9. npm scripts 审计

### 9.1 安装、构建与打包

| script | 实际命令 | 用途 | 初步评级 |
| --- | --- | --- | --- |
| `postinstall` | `node scripts/ensure-node-pty-permissions.mjs` | 修复 node-pty spawn-helper 执行位 | 核心保留 |
| `clean` | 删除 `dist/` | 构建前清理编译输出 | 核心保留 |
| `build` | `clean` + TypeScript build | 生成发布用 `dist/*.js` | 核心保留 |
| `prepack` | `npm run build` | npm pack/publish 前强制构建 | 核心保留 |

### 9.2 质量与测试

| script | 用途 | 初步评级/问题 |
| --- | --- | --- |
| `lint` | 检查 `bin`、`src`、`test` | 核心保留 |
| `lint:fix` | 自动修复 lint | 开发便利，保留 |
| `typecheck:src` | 严格检查源码，包括 unused locals/parameters | 核心保留 |
| `quality` | lint + typecheck + 全测试 + build | 核心质量门禁 |
| `test` | 全量 Bun 测试 | 核心保留 |
| `test:bridge` | `test/bridge` 聚焦测试 | 保留 |
| `test:companion` | `test/companion` 聚焦测试 | 保留 |
| `test:wechat` | `test/wechat` 聚焦测试 | 保留 |
| `test:watch` | 测试 watch 模式 | 开发便利，保留 |

一致性问题：仓库存在 `test/daemon`，但没有 `test:daemon` script。若保留聚焦脚本，应补齐 daemon；否则也可以删除所有聚焦别名，统一直接运行 `bun test test/<area>`。

### 9.3 发布与全局安装验证

| script | 用途 | 初步评级 |
| --- | --- | --- |
| `smoke:global` | 打 tarball、真实全局安装并验证安全 CLI；支持 `--clean-cache`、`--full`、`--keep-tarball`/`--keep-temp`、`--purge-global` | 核心发布验证 |
| `publish:dual` | 发布主包和 scoped 兼容镜像；支持 `--dry-run`、`--registry`、`--tag`、`--otp` | 核心发布流程 |

### 9.4 源码模式运行入口

| script | 对应功能 | 与发布 CLI 的关系 | 初步评级 |
| --- | --- | --- | --- |
| `setup` | 源码运行 WeChat 登录 | `wechat-setup` 的开发镜像 | 开发保留 |
| `start` | 启动源码 MCP server | 没有同名全局 bin；不是 daemon/bridge 主流程 | 待确认整组废弃或重命名为 `mcp:start` |
| `check` | MCP transport 状态检查 | `start --check` 的快捷别名 | 待确认；建议至少重命名为 `mcp:check` |
| `bridge` | 通用内部 bridge，仍要求传 `--adapter` | 无公开 bin，仅供维护者 | 高级开发保留 |
| `daemon` | 源码 daemon | `wechat-daemon` 的开发镜像 | 开发保留 |
| `bridge:codex` | Codex 源码 bridge | 智能 launcher 使用的内部 runtime | 开发保留 |
| `codex:panel` | Codex remote client | daemon/launcher 内部 visible client 的源码入口 | 候选重命名为 `codex:companion` 或 `codex:client` |
| `codex:start` | Codex smart launcher | `wechat-codex` 的源码镜像 | 开发保留 |
| `bridge:claude` | Claude 源码 bridge | 智能 launcher 使用的内部 runtime | 开发保留 |
| `claude:companion` | Claude visible companion | daemon/launcher 内部调试入口 | 开发保留 |
| `claude:start` | Claude smart launcher | `wechat-claude` 的源码镜像 | 开发保留 |
| `bridge:opencode` | OpenCode 源码 bridge | 智能 launcher 使用的内部 runtime | 开发保留 |
| `opencode:panel` | OpenCode local companion | 名称与 `claude:companion`、`pi:companion` 不一致 | 候选重命名为 `opencode:companion` |
| `opencode:start` | OpenCode smart launcher | `wechat-opencode` 的源码镜像 | 开发保留 |
| `bridge:pi` | Pi 源码 bridge | 智能 launcher 使用的内部 runtime | 开发保留 |
| `pi:companion` | Pi visible companion/native TUI | daemon/launcher 内部调试入口 | 开发保留 |
| `pi:start` | Pi smart launcher | `wechat-pi` 的源码镜像 | 开发保留 |
| `bridge:bun` | Bun 直接运行通用 bridge | 与 Node 源码 `bridge` 重复 | 候选废弃 |

## 10. MCP tools 审计

来源：`src/wechat/wechat-channel.ts`，通过 `npm start` 以 stdio MCP server 运行；当前没有独立发布的 `wechat-mcp` 全局命令。

| MCP tool | 用途 | 与 daemon/bridge 的关系 | 初步评级 |
| --- | --- | --- | --- |
| `wechat_get_status` | 查看账户和本地 MCP 状态文件 | 与 `/status` 和 doctor 有信息重叠，但面向 MCP host | 若保留 MCP，则核心 |
| `wechat_fetch_messages` | 使用 sync cursor 主动拉取微信消息；支持 long poll | daemon/bridge 自己内部轮询，不供用户直接调用 | 若保留 MCP，则核心 |
| `wechat_reply` | 按 `sender_id` 回复文本 | bridge final reply 的 MCP 版本 | 与 notify 部分重叠，但收件人语义不同 |
| `wechat_notify` | 主动给指定或最近联系人发送文本 | bridge 主要是对当前 owner 回复 | MCP 主动通知能力 |
| `wechat_send_image` | 加密上传并发送图片 | 与 bridge attachment protocol 重叠 | 媒体类型独立，若保留 MCP 则保留 |
| `wechat_send_file` | 发送普通文件 | 同上 | 保留或与统一 media tool 合并需要 MCP schema 迁移 |
| `wechat_send_voice` | 发送语音/音频 | 同上 | 媒体 wire type 独立 |
| `wechat_send_video` | 发送视频 | 同上 | 媒体 wire type 独立 |
| `wechat_reset_sync` | 清理 sync cursor，可选清 context token cache | 与 setup/doctor 排障能力相邻 | 高风险诊断工具，若保留 MCP 则保留 |

### 10.1 MCP 整组清理的影响

如果确认没有 MCP host 用户，可以作为一个完整批次考虑删除或迁移：

- `npm start`、`npm run check`；
- `src/wechat/wechat-channel.ts`；
- 9 个 MCP tool schema 和 handler；
- `@modelcontextprotocol/sdk` 生产依赖；
- 对应开发文档和历史说明中的当前用法。

不能只删除其中一两个工具就认定完成清理，因为 `wechat_fetch_messages`、reply/notify 和 reset sync 共同组成完整的 pull-based MCP 工作流。

## 11. 内部协议命令：不应作为用户命令删除

### 11.1 Daemon IPC

| command | 调用方 | 用途 | 评级 |
| --- | --- | --- | --- |
| `ensure_slot` | `wechat-*-start` 等 | 确保指定 adapter slot 存在，可选打开 visible CLI | 内部勿动 |
| `switch_adapter` | daemon 客户端/控制流程 | 激活指定 adapter | 内部勿动 |
| `status` | starter、doctor、健康检查 | 查询 daemon 状态和 slot 列表 | 内部勿动 |
| `shutdown` | daemon 重启/清理流程 | 请求优雅关闭 daemon | 内部勿动 |

微信 `/daemon-stop` 最终触发关闭行为，但它不是 IPC `shutdown` 的同一个公开接口。

### 11.2 Local companion 请求

| command | 用途 | 评级 |
| --- | --- | --- |
| `send_input` | 把微信 prompt 发送给可见 companion | 内部勿动 |
| `list_resume_sessions` | 列出可恢复 session | 内部勿动 |
| `list_resume_threads` | 列出可恢复 Codex thread | 内部勿动 |
| `resume_session` | 恢复 session | 内部勿动 |
| `resume_thread` | 恢复 thread | 内部勿动 |
| `create_session` | 创建新 session | 内部勿动 |
| `interrupt` | 中断当前任务 | 内部勿动 |
| `reset` | 重置 adapter runtime | 内部勿动 |
| `dispose` | 关闭 companion/runtime | 内部勿动 |
| `resolve_approval` | 提交 confirm/deny | 内部勿动 |

配套 frame 类型 `hello`、`hello_ack`、`closing`、`request`、`response`、`event`、`state` 也是协议帧，不是用户命令。

### 11.3 Pi extension 请求

| command | 用途 | 评级 |
| --- | --- | --- |
| `prompt` | 向原生 Pi TUI 注入微信 prompt | 内部勿动 |
| `switch_session` | 切换 Pi session 文件 | 内部勿动 |
| `new_session` | 在当前 Pi TUI 中创建新 session | 内部勿动 |
| `abort` | 中断 Pi 当前 turn | 内部勿动 |

Pi extension 还注册内部命令 `__cli_bridge_new` 和 `__cli_bridge_switch`，用于在 Pi 自身命令系统中携带 bridge request ID；不能当作公开 slash command 文档化。

### 11.4 Codex app-server RPC

| 类别 | 方法/事件 | 评级 |
| --- | --- | --- |
| bridge 发起请求 | `initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` | 内部勿动；Codex 协议兼容层 |
| bridge 接收通知 | `thread/started`、`thread/status/changed`、`turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed`、`error`、`serverRequest/resolved` | 内部勿动 |
| bridge 响应 server request | `currentTime/read`、`mcpServer/elicitation/request`、`item/tool/call`、`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput` | 内部勿动 |

这些方法即使名称像“命令”，也是 Codex 上游 JSON-RPC 契约。删除会直接破坏 turn、审批或用户输入。

### 11.5 Claude Code hook 事件

| hook event | 当前用途 | 评级 |
| --- | --- | --- |
| `SessionStart` | 跟踪 session/transcript | 内部勿动 |
| `UserPromptSubmit` | 镜像本地输入并识别微信注入 | 内部勿动 |
| `PermissionRequest` | 审批转发和自动审批 | 内部勿动 |
| `Notification` | 捕获终端通知和审批 fallback | 内部勿动 |
| `Stop` | 提取最终回复并完成 turn | 内部勿动 |
| `StopFailure` | 上报失败 | 内部勿动 |
| `PreToolUse`、`PostToolUse` | 工具生命周期与安全检查 | 内部勿动 |
| `PostCompact` | compact 完成检测 | 内部勿动 |
| `SubagentStop` | 子代理完成事件 | 内部勿动 |

### 11.6 OpenCode SDK 与 SSE

| 类别 | 方法/事件 | 评级 |
| --- | --- | --- |
| SDK session | `session.promptAsync`、`session.create`、`session.abort`、`session.list`、`session.get` | 内部勿动 |
| 审批/问题 | `permission.reply`、`question.reply`、`question.reject` | 内部勿动 |
| 状态事件 | `server.connected`、`server.heartbeat`、`session.idle`、`session.status`、`session.error`、`session.created`、`session.updated` | 内部勿动 |
| 审批与问题事件 | `permission.updated`、`permission.asked`、`permission.replied`、`question.asked`、`question.replied`、`question.rejected` | 内部勿动 |
| 消息事件 | `message.updated`、`message.part.updated`、`message.part.delta`、`message.part.removed`、`message.removed` | 内部勿动 |
| TUI/command 事件 | `tui.prompt.append`、`tui.command.execute`、`tui.session.select`、`command.executed` | 内部勿动 |
| 当前忽略事件 | `session.diff`、`session.diff.delta`、`session.deleted`、`tui.toast.show` 等 | 保留明确忽略，避免未知日志噪声 |

## 12. 已完成与后续清理路线

### 本批已完成

1. 四个直接命令统一为智能 launcher；
2. 四个 `*-start` 变为带警告的一版过渡 aliases；
3. 删除全部公开 `wechat-bridge*` bins；
4. 删除 ShellAdapter、shell npm script、专属测试和公开文档；
5. README 删除手动双终端工作流；
6. 内部 bridge/companion runtime 和维护者调试 scripts 保留；
7. 旧 shell lock/endpoint 继续可读并可清理。

### 下一版本已确定

- 从 npm bin 删除四个 `wechat-*-start` aliases；
- 删除 alias wrappers 和弃用提示测试；
- README、help 和审计文档移除过渡说明。

### 仍待后续确认

1. 是否删除 `bridge:bun`，统一 Node 源码运行路径；
2. 是否把 `codex:panel` 改名为 `codex:client` 或 `codex:companion`；
3. 是否把 `opencode:panel` 改名为 `opencode:companion`；
4. 是否补充 `test:daemon`，或取消全部 `test:<area>` aliases；
5. 若保留 MCP，是否把 `start`、`check` 改名为 `mcp:start`、`mcp:check`；
6. 是否移除 `wechat-check-update`；
7. 是否收敛 `/new-session`、`/yes`、`/no` 等别名；
8. 是否继续维护 emoji 动态绑定与危险的 `[再见] -> /daemon-stop` 默认项。

## 13. 后续核查表

| 问题 | 是 | 否 | 结论影响 |
| --- | --- | --- | --- |
| 是否有人直接运行 `npm start` 接入 MCP host？ |  |  | 决定 MCP server 和 MCP SDK 是否可删 |
| 是否经常运行 `wechat-check-update`？ |  |  | 决定手动更新检查是否保留 |
| 是否真实使用 `/bind`、`/unbind`、`/bindings`？ |  |  | 决定 emoji 配置系统是否值得维护 |
| 是否需要 `/yes`、`/no` 和 bare-text 审批别名？ |  |  | 决定审批命令能否收敛 |
| 是否需要 `/new-session`，还是 `/new` 已足够？ |  |  | 决定会话命令别名是否收敛 |
| 是否有人期望从微信执行 `/resume`？ |  |  | 决定继续拦截提示还是重新实现 |
| 是否接受取消 `[再见] -> /daemon-stop` 默认绑定？ |  |  | 降低误停 daemon 风险 |
| 是否需要为 Pi 增加默认 emoji，或取消全部默认 adapter emoji？ |  |  | 决定默认绑定一致性 |
| 是否允许 npm 开发脚本改名并保留一版兼容 alias？ |  |  | 决定脚本整理方式 |

## 14. 当前审计结论

1. 用户命令面已经从 17 个收敛到过渡期 11 个；下一版本删除四个 start aliases 后将剩 7 个。
2. `wechat-codex`、`wechat-claude`、`wechat-opencode`、`wechat-pi` 现在同时覆盖 daemon 委托和无 daemon 智能启动，不再要求用户理解 bridge/companion 双终端。
3. 公开 bridge bins 已删除，但内部 bridge runtime 仍是微信连接、锁、状态、审批和转发的必要组件。
4. Shell adapter 已退出产品范围；仅保留旧状态识别，避免升级后留下无法清理的 shell lock/endpoint。
5. 最明确的剩余无效公开命令仍是微信 `/resume`：当前只有拦截提示，没有实际执行路径。
6. 最可能形成下一轮大规模减法的是源码 MCP server 整组，但必须先确认是否仍有外部 MCP 用户。
7. daemon IPC、local companion、Pi extension、Codex RPC、Claude hooks 和 OpenCode SDK/SSE 仍属于内部协议，不应计入用户命令冗余。
