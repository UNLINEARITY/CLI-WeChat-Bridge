export const messages: Record<string, string> = {
  // === Bridge welcome & control ===
  "bridge.welcome": "WeChat Bridge ready ({adapter}).\nCWD: {cwd}\n\nCommands: /stop, /confirm, /deny, /status, /new\n{bindings}\n\nManage: /bind [emoji] cmd, /unbind [emoji], /bindings",
  "bridge.stopped": "Bridge stopped.",
  "bridge.interrupt.sent": "Interrupt signal sent.",
  "bridge.interrupt.notBusy": "No active task to interrupt.",
  "bridge.reset.done": "Worker session has been reset.",
  "bridge.status.notRunning": "{adapter} adapter is not running.",
  "bridge.status.busy": "{adapter} is still working on the previous request. Wait for it to finish or send /interrupt.",
  "bridge.newSession.done": "New session started.",
  "bridge.fatalError": "Bridge error: {message}",

  // === Daemon welcome & control ===
  "daemon.welcome": "WeChat Daemon ready.\nCWD: {cwd}\nActive: {adapter}\n\nCommands: /claude, /codex, /opencode, /stop, /confirm, /deny, /status\n{bindings}\n\nManage: /bind [emoji] cmd, /unbind [emoji], /bindings",
  "daemon.noActiveAdapter": "No active terminal is selected. Send /codex, /claude, or /opencode to start one.",
  "daemon.switchResult.new": "Started a new visible CLI.",
  "daemon.switchResult.reused": "Reused the existing visible CLI.",

  // === Approval ===
  "approval.prompt": "{adapter} permission request.\n{summary}\n\nReply /confirm or /deny.",
  "approval.confirmed": "Approval confirmed. Continuing...",
  "approval.denied": "Approval denied.",
  "approval.noPending": "No pending approval request.",
  "approval.batchConfirmed": "Batch confirmed {count} approval(s).",
  "approval.batchDenied": "Batch denied {count} approval(s).",

  // === Hook health check ===
  "hook.healthCheck.warning": "[Warning] No hook events received from Claude after 15s.\nThe hook system may not be working — Claude output will not reach WeChat.",
  "hook.healthCheck.logHint": "\nCheck: {logPath}",
  "hook.healthCheck.fixes": "\nCommon fixes:\n- Ensure Node.js >= 22.6.0: node --version\n- Reinstall: npm install -g cli-wechat-bridge@latest\n- Check firewall: allow localhost TCP connections",

  // === PTY fallback ===
  "pty.fallback.warning": "[Warning] PTY unavailable, using fallback mode. Terminal rendering may be degraded.\n",

  // === Spawn diagnostic ===
  "spawn.diagnostic.title": "Failed to start CLI process: {target}\nError: {error}",
  "spawn.diagnostic.fixesHeader": "\nPossible fixes:",
  "spawn.diagnostic.nodePty": "- The node-pty native module is incompatible with your Node.js version.\n- Run: npm rebuild node-pty\n- Or reinstall: npm install -g cli-wechat-bridge@latest",
  "spawn.diagnostic.xcode": "- Ensure Xcode CLI tools are installed: xcode-select --install",
  "spawn.diagnostic.notFound": "- The command \"{target}\" was not found on PATH.\n- Verify it is installed and accessible from your terminal.",
  "spawn.diagnostic.generic": "- Reinstall: npm install -g cli-wechat-bridge@latest",
  "spawn.diagnostic.nodeVersion": "- Ensure Node.js >= 22.6.0: node --version",
  "spawn.diagnostic.winAdmin": "- If using ConPTY, try running as Administrator.",

  // === Emoji bindings ===
  "binding.usage": "Invalid format.\nUsage: /bind [emoji] command\nExample: /bind 🚀 deploy --prod",
  "binding.bound": "Bound {emoji} → {command}",
  "binding.unbound": "Unbound {emoji}.",
  "binding.notFound": "No binding found for {emoji}.",
  "binding.listEmpty": "No emoji bindings configured.",
  "binding.listHeader": "Emoji bindings:",

  // === Version checker ===
  "update.available": "[Update Available] Version {latest} is available (current: {current}).\nRun: npm install -g cli-wechat-bridge@latest",
};
