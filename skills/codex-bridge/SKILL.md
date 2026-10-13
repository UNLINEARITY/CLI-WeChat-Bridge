---
name: codex-bridge
description: Attach WeChat to the current Codex conversation through the shared Codex app-server daemon, or manage the attached bridge. Use for $codex-bridge requests from Codex TUI sessions; this skill does not apply to Claude Code, OpenCode, Pi, or embedded (desktop app) Codex sessions.
---

# Codex Bridge

Attach the CLI WeChat Bridge to the **current** Codex conversation. The bridge joins the shared Codex app-server daemon (`~/.codex/app-server-control/app-server-control.sock`, codex >= 0.162 default mode) as a second client and rejoins this session's live thread: WeChat messages become turns in this same thread, replies and approvals flow back to WeChat, and the local Codex session keeps working unchanged.

Keep the invoking Codex conversation and its context. Default to WeChat unless the user asks for WeCom (`wecom-codex --channel wecom ...`).

## Attach the current conversation

1. Resolve the launcher: the installed package's `wechat-codex` (find it with `npm root -g`; primary package `cli-wechat-bridge`, mirror `@unlinearity/cli-wechat-bridge`), or `npm run bridge:codex`-equivalent from a source checkout.
2. Run the attach command from the project directory (or pass `--cwd`):
   ```bash
   wechat-codex --cwd <project> --attach-current-session
   ```
   It starts a background bridge that discovers the newest **live** daemon session in `<project>` and binds to it. Success prints `Attached Codex daemon thread <id>`. Attach with an explicit thread via `--codex-thread-id <id>` when several live sessions share the directory.
3. Verify before claiming success: the launcher printed `Attached Codex daemon thread`, or `~/.cli-bridge/workspaces/<workspace-key>/bridge-state.json` has a `sharedThreadId`. A WeChat message that reaches this conversation and whose reply returns to WeChat is the full proof.
4. Do not run plain `wechat-codex` as a substitute: that opens a new bridge-managed visible client and does NOT attach this conversation. Never report "connected" based on a login, a status read, or a new session.

## Boundaries — report these honestly

- `No shared Codex app-server daemon socket at ...`: codex < 0.162 or no shared background server. Upgrade codex and retry.
- `No live Codex daemon session found for <project>`: no daemon-attached session in this directory. Open codex normally (>= 0.162) in the project and retry.
- `thread ... already has an active writer`: the target session is **embedded** (desktop app, `--no-daemon`, `--oss`, `--profile`). Embedded sessions cannot be attached; say so instead of falling back to opening another session.
- A daemon (`wechat-daemon`/`wecom-daemon`) owning the workspace blocks attach (it holds the bridge lock); stop it first or use its slots.

## Status, switching, and shutdown

- Status: `~/.cli-bridge/workspaces/<workspace-key>/bridge-state.json` (`sharedThreadId`, status) and `~/.cli-bridge/bridge.log`.
- Switch to another conversation: run the attach command again from that session's project directory; it replaces the previous attach bridge for the workspace.
- Shutdown: send `/shutdown` from WeChat, or stop the bridge process holding `~/.cli-bridge/bridge.lock.json`.
- Attach does not kill or restart anything: the shared daemon, the owning TUI, and all turns stay intact; the bridge is a guest client and turns it injects appear live in the local session.
