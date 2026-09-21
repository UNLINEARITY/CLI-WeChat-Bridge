# Repository Guidelines

## Project Mental Model
CLI WeChat Bridge lets one WeChat iLink account or one WeCom smart-bot account drive local CLI agents from a normal project directory. The user-facing npm package is `cli-wechat-bridge`; `@unlinearity/cli-wechat-bridge` is kept as a compatibility mirror for existing users.

There are two runtime shapes:
- `wechat-daemon`: the preferred long-lived mode. It owns one WeChat connection for one startup working directory, keeps Codex, Claude Code, OpenCode, and Pi slots alive, and switches from WeChat with `/codex`, `/claude`, `/opencode`, and `/pi`. Switching reuses an already connected visible CLI, or opens a new visible CLI when needed.
- `wecom-daemon`: the equivalent long-lived mode for the official WeCom smart-bot WebSocket channel; it uses the same adapter slots and command grammar with WeCom-specific credentials and conversation state.
- Direct launchers: `wechat-codex`, `wechat-claude`, `wechat-opencode`, `wechat-pi` and their `wecom-*` counterparts delegate to a same-cwd daemon when available; otherwise they create an internal companion-bound bridge runtime and open the visible CLI. Public `wechat-bridge-*` commands no longer exist.

Runtime data now lives under `~/.cli-bridge` by default. Legacy data is copy-migrated from `~/.claude/channels/wechat` and from `CLAUDE_WECHAT_CHANNEL_DATA_DIR` only as a migration source. Use `CLI_BRIDGE_DATA_DIR` for the active data directory.

## Mandatory Owner Workflow (Hard Rules)
These rules are owner-imposed and override anything else in this file, including agent defaults:

1. **No git writes without explicit approval.** Never create a commit, push, tag, or publish unless the owner approves that specific action in this session. Prepare the change, summarize what would be committed, and ask. "Ready to commit" means ask, not act.
2. **No double-log writes without explicit instruction.** Never write to `log.md` or `git-log.md` unless the owner explicitly asks for that entry. When asked, keep the `## [日期] 标题` headers identical across both files.
3. **Internal documents are local-only.** Planning, audit, and research documents that are not end-user documentation must never be staged, committed, pushed, or packaged. This includes `docs/channel-agnostic-orchestration-plan.md`, `docs/turn-routing-hardening-plan.md`, `docs/cli-compatibility-and-routing-audit.md`, and any future plan/audit/working notes. Only user-facing documentation belongs in git: `README.md`, `docs/releases/*`, `docs/architecture.md`, `docs/development.md`, `docs/configuration.md`, `docs/command-audit.md`, and similar.
4. **No retroactive history edits.** Never rewrite published commits, tags, or release docs without direct instruction.
5. **Preserve license headers.** This repository is AGPL-3.0-or-later. Every source file starts with an SPDX copyright header that must be kept intact in new files and modifications; never remove or alter it. Any contributor or AI agent making modifications that are later distributed or served over a network must release the complete corresponding source under AGPL-3.0-or-later (see README License section). New source files must carry the same header.

## Project Structure
- `src/wechat`: iLink setup, channel config, long polling, message send, inbound media download/decryption, stale context-token handling, and transport logging.
- `src/channels/wechat`: WeChat channel port, channel-neutral message conversion, and forwarding helpers on top of `src/wechat`.
- `src/channels/wecom`: official smart-bot setup/pairing, WebSocket transport, message conversion, media transfer, and channel-specific reply formatting.
- `src/core`: channel-neutral orchestration primitives — channel types and `BridgeChannelPort`, `routeBridgeMessage`, `InboundConversationContext`/`TurnCoordinator` turn ownership, bridge event forwarding, control-command parsing, inbound message claims, and shared text utilities. Keep orchestration logic channel-neutral here; channel specifics live under `src/channels/*` and `src/wechat`.
- `src/bridge`: bridge lifecycle, adapter selection, controller orchestration, approvals, user-input requests, final-reply forwarding, locks, workspace state, process cleanup, and shared formatting.
- `src/bridge/bridge-adapters.*.ts`: adapter-specific Codex, Claude Code, OpenCode, and Pi behavior. Keep adapter conditionals here or in closely related companion modules.
- `src/companion`: visible local CLI companion launchers, IPC endpoint files, daemon delegation, and local companion proxy support.
- `src/daemon`: persistent WeChat/WeCom daemon, daemon IPC, multi-slot switching, visible terminal auto-open, and pre-start cleanup of stale single bridges.
- `src/runtime`: bridge-owned runtime host creation, including the Codex runtime host and legacy adapter runtime wrapper.
- `src/i18n`: localized user-facing strings.
- `src/types` and `src/media`: shared type and attachment metadata definitions.
- `src/commands` and `src/utils`: global command helpers and update checking.
- `bin/*.mjs`: published CLI wrappers. These are tracked source files, not generated output.
- `scripts`: release and packaging helpers, especially `publish-dual.mjs`, `smoke-global-install.mjs`, and `smoke-cli-compatibility.mjs`.
- `test/<area>` mirrors the runtime areas: `bridge`, `companion`, `core`, `daemon`, `wechat`, and `wecom`.
- `docs/releases`: release notes and the release index. Keep English and Chinese notes aligned when preparing a release.

## Runtime State And Files
Default active state is in `~/.cli-bridge`:
- `account.json`, `sync_buf.txt`, `context_tokens.json`: WeChat login and sync state.
- `wecom/account.json`: WeCom Bot credentials and paired operator identity.
- `bridge.log`: combined bridge and daemon runtime log.
- `bridge.lock.json`: single-bridge ownership lock.
- `daemon-endpoint.json`: daemon IPC endpoint.
- `workspaces/<workspace-key>/bridge-state.json`: workspace-scoped bridge state.
- `workspaces/<workspace-key>/codex-panel-endpoint*.json`: adapter-scoped local companion endpoints.
- `inbound-attachments/<date>/`: downloaded WeChat images and files.
- `wecom/inbound-attachments/<date>/`: downloaded WeCom media files.
- `inbound-message-claims/`: cross-process inbound message deduplication claims.

Do not commit local credentials, runtime state, logs, generated `dist/`, `node_modules/`, or ignored local planning/artifact directories. `log.md` and `git-log.md` are intentionally local-only in this public repository; only edit them when the user explicitly asks for the repo's double log, and never stage, commit, push, publish, or package them. Internal planning/audit/research documents are local-only in the same way (see Mandatory Owner Workflow).

## Build, Test, And Development Commands
Install dependencies:
```bash
bun install
```

Source-mode setup and checks:
```bash
npm run setup
npm run check
npm run daemon -- --adapter codex
npm run daemon -- --channel wecom --adapter claude
npm run bridge:codex
npm run bridge:claude
npm run bridge:opencode
npm run codex:start
npm run claude:start
npm run opencode:start
```

Quality gates:
```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
npm run quality
```

Focused tests:
```bash
bun test test/bridge
bun test test/companion
bun test test/daemon
bun test test/wechat
bun test test/wecom
```

Packaging and global smoke validation:
```bash
npm pack --dry-run --json
npm run smoke:global -- --purge-global --clean-cache
npm run smoke:global -- --purge-global --clean-cache --full
npm run smoke:cli-compat
```

The project runs TypeScript directly in source mode with Node 24 strip-types support, but published packages must ship compiled `dist/*.js`. Keep `prepack` and `npm run build` working before any npm release.

## Coding Style
Use TypeScript ESM with strict typing. Match the local style: 2-space indentation, semicolons, double quotes, and explicit `.ts` imports in source and test files. Prefer `camelCase` for values/functions, `PascalCase` for classes/types, and kebab-case filenames such as `bridge-final-reply.ts`.

Keep edits small and behavior-scoped. Do not introduce cross-cutting adapter conditionals unless the surrounding architecture already centralizes that decision. Prefer existing helpers for locks, endpoint files, process cleanup, runtime host creation, transport error formatting, and WeChat prompt formatting.

`bin/*.mjs` wrappers must stay LF-normalized because npm installs them as executable shebang entrypoints. `.gitattributes` pins this; do not ignore or regenerate `bin/`.

## Testing Expectations
Use `bun:test`. Name files `*.test.ts` and place them under the matching `test/<area>` directory.

Add focused regression coverage when changing:
- bridge ownership, locks, stale lock cleanup, daemon takeover, or process reaping;
- conversation routing, turn ownership, busy dispatch rejection, rollback, or slot output targeting (shared `TurnCoordinator` behavior);
- daemon switching, visible CLI auto-open, daemon IPC, or same-cwd delegation;
- adapter final replies, session/thread following, approvals, Codex `request_user_input`, or adapter task completion (`task_complete` must fire on every settled turn);
- WeChat transport, retry classification, stale context-token handling, inbound media download, AES decryption, or attachment prompt injection;
- global command wrappers, package metadata, release scripts, or npm install behavior.

For release-facing changes, run `npm run quality` plus package/smoke checks. For narrow fixes, run the smallest focused test first, then expand to the relevant suite.

## Daemon And Bridge Behavior
`wechat-daemon` and `wecom-daemon` are the preferred user workflows. Each binds to its startup cwd; v1 does not switch to a different local project directory from the remote channel. If a same-cwd daemon is live, the matching four direct launchers should delegate to the daemon instead of replacing it. The expired `wechat-*-start` compatibility aliases were removed in 1.1.5; use the direct launchers.

Daemon startup should clean stale or still-running single-bridge state automatically when possible. Do not push cleanup work onto the user if the code can safely detect and clear stale locks, dead endpoints, peer bridge processes, or orphan OpenCode processes. When changing cleanup logic, update daemon tests and make logs explicit enough to diagnose what was cleaned.

Internal transient bridges must refuse to start when a live daemon owns the workspace. If an endpoint is stale, clear it and continue using existing helper functions.

Visible CLI clients always start fresh sessions by default (`new`) in both daemon and direct-launch modes. Do not pre-create shared sessions for visible clients: Codex 0.155 persists app-server threads lazily, and resuming a fresh, not-yet-persisted thread id crashes the visible TUI with "no rollout found". Restores of already persisted threads remain available through explicit `--session-start-mode restore`, WeChat `/resume`, and reuse of an already connected visible window.

## CLI Compatibility Maintenance
The bridge tracks the latest stable CLI releases it depends on:
- Codex validated range: 0.149.x through 0.155.x (see `isCodexVersionInCompatibilityRange`).
- Claude Code, OpenCode, and Pi are validated against the latest stable releases via capability probes, not version ranges.
- Pi 0.85 requires Node.js >= 22.19.0; launchers and the daemon enforce this before starting the visible TUI.

`.github/workflows/cli-compatibility.yml` runs every Monday 04:23 UTC (and on demand), installs the latest stable CLIs, and runs `npm run smoke:cli-compat` (`scripts/smoke-cli-compatibility.mjs`) to verify Codex schema generation, Claude `--settings`, OpenCode server health, and Pi extension capabilities. It is deliberately not a required check; triage failures by comparing the smoke output against `src/bridge/bridge-adapters.*.ts` usage.

## WeChat, WeCom, Attachments, And Transport
Inbound WeChat images and files are downloaded to `~/.cli-bridge/inbound-attachments/<date>/` and forwarded to the selected CLI as local paths in the prompt. This project saves and exposes attachment paths; it does not implement OCR or document parsing inside the bridge.

Inbound WeCom images, files, and videos are downloaded to `~/.cli-bridge/wecom/inbound-attachments/<date>/` and forwarded to the selected CLI as local paths. WeCom uses the official smart-bot WebSocket SDK; each Bot ID may have only one active connection.

`sendmessage ret=-2` is a stale WeChat context-token condition, not a generic send failure. Preserve the targeted cache-clearing and user-facing guidance around sending a fresh WeChat message after startup or long idle periods.

Network failures to `https://ilinkai.weixin.qq.com` may be proxy-related even when bridge state is healthy. Node `fetch()` needs appropriate `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and on Node 24+ may use `NODE_USE_ENV_PROXY=1`; keep `NO_PROXY=127.0.0.1,localhost,::1` so local daemon/companion traffic stays direct. Do not set `NODE_OPTIONS=--use-env-proxy` on Node 22.13.

## Dual npm Package Publishing
The root `package.json` must keep:
```json
"name": "cli-wechat-bridge"
```

Publish both package names with:
```bash
npm run publish:dual -- --dry-run
npm run publish:dual -- --otp <code>
```

`scripts/publish-dual.mjs` is the source of truth for dual publishing:
- it builds once before publishing;
- it publishes `cli-wechat-bridge` from the repository root;
- it creates a temporary scoped mirror package named `@unlinearity/cli-wechat-bridge`;
- the mirror contains `bin/`, `dist/`, `README.md`, `LICENSE.txt`, and rewritten package metadata without scripts/devDependencies;
- it checks `<package>@<version>` first and skips already-published versions;
- if one package publishes and the other fails, rerun the same script after fixing auth; the completed package will be skipped.

Do not manually rename `package.json` to publish the scoped package. Do not claim a package was published until `npm view <name> version dist-tags --registry=https://registry.npmjs.org/ --json` confirms it.

README badges cannot natively combine download counts for two npm packages. Keep primary package badges pointed at `cli-wechat-bridge` and use a separate scoped-package downloads badge for compatibility visibility.

## Release Process
Use this checklist for a normal release:
1. Inspect the real diff since the previous release/tag and identify user-visible changes.
2. Update `package.json`, `package-lock.json`, and the root workspace `version` in `bun.lock` to the target version.
3. Update `README.md` only for real workflow, install, migration, or compatibility changes. Keep README edits additive and preserve existing user-authored prose unless a broader rewrite is explicitly requested.
4. Add or update `docs/releases/<version>.md`, `docs/releases/<version>_CN.md`, and `docs/releases/README.md`.
5. Run `npm run quality`.
6. Run `npm pack --dry-run --json` and verify the tarball contains `bin/`, `dist/`, `README.md`, and `LICENSE.txt`, not `src/`, tests, local state, or `node_modules`.
7. Run `npm run smoke:global -- --purge-global --clean-cache`; use `--full` when validating the complete release path.
8. Run `npm publish --dry-run --access public`.
9. Run `npm run publish:dual -- --dry-run`.
10. Push `main` and the plain `x.y.z` tag together (for example `git push origin main 1.1.8`). The Release workflow runs the full quality gate and creates the GitHub Release whose body combines `docs/releases/<tag>_CN.md` with GitHub's auto-generated changelog. The tag must point at a commit that contains both the release notes and `.github/workflows/release.yml`; verify the workflow run and the resulting release before proceeding. Do not publish npm packages before the tag-release gate passes.
11. Publish with `npm run publish:dual -- --otp <code>` when npm requests OTP, or without `--otp` when web auth is already valid.
12. Verify both registries:
```bash
npm view cli-wechat-bridge version dist-tags --registry=https://registry.npmjs.org/ --json
npm view @unlinearity/cli-wechat-bridge version dist-tags --registry=https://registry.npmjs.org/ --json
```
13. Only after live registry verification, update `log.md` and `git-log.md` if the user asks for double log entries.

If npm returns `EOTP`, `E401`, or `E404` during real publish, record it as an auth/registry blocker until registry reads prove otherwise. Dry-runs are validation, not publication.

## Commit And PR Guidance
All commits require explicit owner approval first (see Mandatory Owner Workflow). Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `build:`, and `chore:`. Keep subjects imperative and behavior-focused, for example `fix: preserve daemon visible companion occupancy`.

PRs should describe:
- affected adapter(s) or runtime area;
- user-visible behavior change;
- migration or compatibility impact;
- commands run;
- relevant WeChat output or terminal snippets for approval, onboarding, daemon switching, or message formatting changes.

Before committing, inspect `git status --short --ignored`. Do not commit ignored local runtime state, the local-only `log.md` and `git-log.md`, or local-only internal planning/audit documents (see Mandatory Owner Workflow).

## Troubleshooting Workflow For Agents
When behavior is unclear, inspect real state before changing code:
- `~/.cli-bridge/bridge.log` for bridge/daemon runtime events;
- `~/.cli-bridge/daemon-endpoint.json` for daemon ownership;
- `~/.cli-bridge/bridge.lock.json` for single-bridge ownership;
- `~/.cli-bridge/workspaces/<workspace-key>/bridge-state.json` for active adapter/session state;
- adapter-scoped companion endpoint files under the workspace state directory.

Missing WeChat replies usually reduce to one of these questions: did the active adapter emit `final_reply`; was the active turn WeChat-owned; did transport send fail; did stale context-token handling clear the right recipient token; or did daemon switching target a different cwd.

Prefer surgical fixes backed by focused tests. Avoid broad rewrites of adapter flow, transport state, or release docs unless the user explicitly asks for a larger redesign.
