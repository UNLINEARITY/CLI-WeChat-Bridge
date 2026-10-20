---
name: codex-bridge
description: Attach a messaging channel (WeChat, WeCom, or Telegram) to the current Codex conversation through the shared Codex app-server daemon, or manage the attached bridge. Use for $codex-bridge requests from Codex TUI sessions; this skill does not apply to Claude Code, OpenCode, Pi, or embedded (desktop app) Codex sessions.
---

# Codex Bridge

Attach the CLI WeChat Bridge to the **current** Codex conversation. The bridge joins the shared Codex app-server daemon (`~/.codex/app-server-control/app-server-control.sock`, codex >= 0.162 default mode) as a second client and rejoins this session's live thread: channel messages become turns in this same thread, replies and approvals flow back to the channel, and the local Codex session keeps working unchanged.

Keep the invoking Codex conversation and its context. The launcher prefix selects the channel — `wechat-codex`, `wecom-codex`, or `telegram-codex`; default to WeChat unless the user names another channel.

## Attach the current conversation

1. Resolve the launcher: the installed package's `wechat-codex` / `wecom-codex` / `telegram-codex` (find it with `npm root -g`; primary package `cli-wechat-bridge`, mirror `@unlinearity/cli-wechat-bridge`), or the source-checkout equivalents.
2. Run the attach command from the project directory (or pass `--cwd`):
   ```bash
   <channel>-codex --cwd <project> --attach-current-session   # prefix: wechat | wecom | telegram
   ```
   It starts a background bridge that discovers the newest **live** daemon session in `<project>` and binds to it. Success prints `Attached Codex daemon thread <id>`. Attach with an explicit thread via `--codex-thread-id <id>` when several live sessions share the directory.
3. Verify before claiming success: the launcher printed `Attached Codex daemon thread`, or `~/.cli-bridge/workspaces/<workspace-key>/slot-session-codex.json` has a `sharedSessionId`. A message that reaches this conversation and whose reply returns to the channel is the full proof.
4. Do not run plain `wechat-codex` as a substitute: that opens a new bridge-managed visible client and does NOT attach this conversation. Never report "connected" based on a login, a status read, or a new session.

## Boundaries — report these honestly

- `No shared Codex app-server daemon socket at ...`: codex < 0.162 or no shared background server. Upgrade codex and retry.
- `No live Codex daemon session found for <project>`: no daemon-attached session in this directory. Open codex normally (>= 0.162) in the project and retry.
- `thread ... already has an active writer`: the target session is **embedded** (desktop app, `--no-daemon`, `--oss`, `--profile`). Embedded sessions cannot be attached; say so instead of falling back to opening another session.
- `codex is already running for <project> in another terminal, and this bridge runs several CLI types`: the bridge is in multi-CLI mode and this directory already has codex. Close that Codex window first, or attach from another directory; attach does not replace it.
- `The <channel> bridge is running several windows of one CLI type`: the bridge is in multi-instance mode for another CLI in this directory. Attach from another directory, or close those windows first.
- A running daemon of another channel blocks attach; stop it first. A daemon of the same channel is joined, not replaced.

## Status, switching, and shutdown

- Status: `/status` from the channel (`/cd` once the bridge spans several directories, where attached terminals show as `codex (attached)`), `~/.cli-bridge/workspaces/<workspace-key>/slot-session-codex.json`, and `~/.cli-bridge/bridge.log`.
- Attach counts as a codex window for the bridge mode: next to a single codex window it becomes `codex-2`, next to another CLI it moves the bridge to multi-CLI mode, and in another directory to multi-directory mode.
- Switch to another conversation: in another project directory, run the attach command there (it is added alongside, switch with `/cd`); in the same directory, use `/resume` from the channel.
- Shutdown: send `/daemon-stop` from the channel; it stops the whole bridge daemon.
- Attach does not kill or restart anything: the shared daemon, the owning TUI, and all turns stay intact; the bridge is a guest client and turns it injects appear live in the local session.
