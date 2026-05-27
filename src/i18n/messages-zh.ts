export const messages: Record<string, string> = {
  // === 桥接欢迎 & 控制 ===
  "bridge.welcome": "微信桥接就绪 ({adapter})。\n工作目录: {cwd}\n\n命令: /stop, /confirm, /deny, /status, /new\n{bindings}\n\n管理: /bind [表情] 命令, /unbind [表情], /bindings",
  "bridge.stopped": "桥接已停止。",
  "bridge.interrupt.sent": "已发送中断信号。",
  "bridge.interrupt.notBusy": "没有正在执行的任务可中断。",
  "bridge.reset.done": "会话已重置。",
  "bridge.status.notRunning": "{adapter} 适配器未运行。",
  "bridge.status.busy": "{adapter} 仍在处理上一个请求。请等待完成或发送 /interrupt。",
  "bridge.newSession.done": "已开始新会话。",
  "bridge.fatalError": "桥接错误: {message}",

  // === Daemon 欢迎 & 控制 ===
  "daemon.welcome": "微信 Daemon 就绪。\n工作目录: {cwd}\n当前: {adapter}\n\n命令: /claude, /codex, /opencode, /stop, /confirm, /deny, /status\n{bindings}\n\n管理: /bind [表情] 命令, /unbind [表情], /bindings",
  "daemon.noActiveAdapter": "未选择活跃终端。发送 /codex、/claude 或 /opencode 启动一个。",
  "daemon.switchResult.new": "已启动新的可见 CLI。",
  "daemon.switchResult.reused": "已复用现有的可见 CLI。",

  // === 审批 ===
  "approval.prompt": "{adapter} 权限请求。\n{summary}\n\n回复 /confirm 或 /deny。",
  "approval.confirmed": "已确认审批，继续执行...",
  "approval.denied": "已拒绝审批。",
  "approval.noPending": "没有待处理的审批请求。",
  "approval.batchConfirmed": "已批量确认 {count} 个审批。",
  "approval.batchDenied": "已批量拒绝 {count} 个审批。",

  // === Hook 健康检查 ===
  "hook.healthCheck.warning": "[警告] 15 秒内未收到 Claude hook 事件。\nhook 系统可能未正常工作 — Claude 的输出将无法到达微信。",
  "hook.healthCheck.logHint": "\n查看日志: {logPath}",
  "hook.healthCheck.fixes": "\n常见修复方法:\n- 确保 Node.js >= 22.6.0: node --version\n- 重新安装: npm install -g cli-wechat-bridge@latest\n- 检查防火墙: 允许 localhost TCP 连接",

  // === PTY 回退 ===
  "pty.fallback.warning": "[警告] PTY 不可用，已切换到回退模式。终端渲染可能受限。\n",

  // === 启动诊断 ===
  "spawn.diagnostic.title": "无法启动 CLI 进程: {target}\n错误: {error}",
  "spawn.diagnostic.fixesHeader": "\n可能的修复方法:",
  "spawn.diagnostic.nodePty": "- node-pty 原生模块与当前 Node.js 版本不兼容。\n- 运行: npm rebuild node-pty\n- 或重新安装: npm install -g cli-wechat-bridge@latest",
  "spawn.diagnostic.xcode": "- 确保已安装 Xcode 命令行工具: xcode-select --install",
  "spawn.diagnostic.notFound": "- 命令 \"{target}\" 未在 PATH 中找到。\n- 请确认已安装并可从终端访问。",
  "spawn.diagnostic.generic": "- 重新安装: npm install -g cli-wechat-bridge@latest",
  "spawn.diagnostic.nodeVersion": "- 确保 Node.js >= 22.6.0: node --version",
  "spawn.diagnostic.winAdmin": "- 如使用 ConPTY，请尝试以管理员身份运行。",

  // === Emoji 绑定 ===
  "binding.usage": "格式错误。\n用法: /bind [表情] 命令\n示例: /bind 🚀 deploy --prod",
  "binding.bound": "已绑定 {emoji} → {command}",
  "binding.unbound": "已解绑 {emoji}。",
  "binding.notFound": "未找到 {emoji} 的绑定。",
  "binding.listEmpty": "未配置 emoji 绑定。",
  "binding.listHeader": "Emoji 绑定列表:",

  // === 版本检查 ===
  "update.available": "[有新版本] 版本 {latest} 可用（当前: {current}）。\n运行: npm install -g cli-wechat-bridge@latest",
};
