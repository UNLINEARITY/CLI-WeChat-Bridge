# Repository Guidelines

## Project Mental Model
CLI WeChat Bridge lets one WeChat iLink account drive local CLI agents from a normal project directory. The user-facing npm package is `cli-wechat-bridge`; `@unlinearity/cli-wechat-bridge` is kept as a compatibility mirror for existing users.

There are two runtime shapes:
- `wechat-daemon`: the preferred long-lived mode. It owns one WeChat connection for one startup working directory, keeps Codex, Claude Code, OpenCode, and Pi slots alive, and switches from WeChat with `/codex`, `/claude`, `/opencode`, and `/pi`. Switching reuses an already connected visible CLI, or opens a new visible CLI when needed.
- Direct launchers: `wechat-codex`, `wechat-claude`, `wechat-opencode`, and `wechat-pi` delegate to a same-cwd daemon when available; otherwise they create an internal companion-bound bridge runtime and open the visible CLI. Public `wechat-bridge-*` commands no longer exist.

Runtime data now lives under `~/.cli-bridge` by default. Legacy data is copy-migrated from `~/.claude/channels/wechat` and from `CLAUDE_WECHAT_CHANNEL_DATA_DIR` only as a migration source. Use `CLI_BRIDGE_DATA_DIR` for the active data directory.

## Project Structure
- `src/wechat`: iLink setup, channel config, long polling, message send, inbound media download/decryption, stale context-token handling, and transport logging.
- `src/bridge`: bridge lifecycle, adapter selection, controller orchestration, approvals, user-input requests, final-reply forwarding, locks, workspace state, process cleanup, and shared formatting.
- `src/bridge/bridge-adapters.*.ts`: adapter-specific Codex, Claude Code, OpenCode, and Pi behavior. Keep adapter conditionals here or in closely related companion modules.
- `src/companion`: visible local CLI companion launchers, IPC endpoint files, daemon delegation, and local companion proxy support.
- `src/daemon`: persistent WeChat daemon, daemon IPC, multi-slot switching, visible terminal auto-open, and pre-start cleanup of stale single bridges.
- `src/runtime`: bridge-owned runtime host creation, including the Codex runtime host and legacy adapter runtime wrapper.
- `src/media`: shared media/attachment metadata types.
- `src/commands` and `src/utils`: global command helpers and update checking.
- `bin/*.mjs`: published CLI wrappers. These are tracked source files, not generated output.
- `scripts`: release and packaging helpers, especially `publish-dual.mjs` and `smoke-global-install.mjs`.
- `test/<area>` mirrors the runtime areas: `bridge`, `companion`, `daemon`, and `wechat`.
- `docs/releases`: release notes and the release index. Keep English and Chinese notes aligned when preparing a release.

## Runtime State And Files
Default active state is in `~/.cli-bridge`:
- `account.json`, `sync_buf.txt`, `context_tokens.json`: WeChat login and sync state.
- `bridge.log`: combined bridge and daemon runtime log.
- `bridge.lock.json`: single-bridge ownership lock.
- `daemon-endpoint.json`: daemon IPC endpoint.
- `workspaces/<workspace-key>/bridge-state.json`: workspace-scoped bridge state.
- `workspaces/<workspace-key>/codex-panel-endpoint*.json`: adapter-scoped local companion endpoints.
- `inbound-attachments/<date>/`: downloaded WeChat images and files.
- `inbound-message-claims/`: cross-process inbound message deduplication claims.

Do not commit local credentials, runtime state, logs, generated `dist/`, `node_modules/`, or ignored local planning/artifact directories. `log.md` and `git-log.md` are intentionally ignored; only edit them when the user explicitly asks for the repo's double log, and use `git add -f log.md git-log.md` if they must be committed.

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
```

Packaging and global smoke validation:
```bash
npm pack --dry-run --json
npm run smoke:global -- --purge-global --clean-cache
npm run smoke:global -- --purge-global --clean-cache --full
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
- daemon switching, visible CLI auto-open, daemon IPC, or same-cwd delegation;
- adapter final replies, session/thread following, approvals, or Codex `request_user_input`;
- WeChat transport, retry classification, stale context-token handling, inbound media download, AES decryption, or attachment prompt injection;
- global command wrappers, package metadata, release scripts, or npm install behavior.

For release-facing changes, run `npm run quality` plus package/smoke checks. For narrow fixes, run the smallest focused test first, then expand to the relevant suite.

## Daemon And Bridge Behavior
`wechat-daemon` is the preferred user workflow. It binds to its startup cwd; v1 does not switch to a different local project directory from WeChat. If a same-cwd daemon is live, the four direct launchers should delegate to the daemon instead of replacing it. The expired `wechat-*-start` compatibility aliases were removed in 1.1.5; use the four direct launchers.

Daemon startup should clean stale or still-running single-bridge state automatically when possible. Do not push cleanup work onto the user if the code can safely detect and clear stale locks, dead endpoints, peer bridge processes, or orphan OpenCode processes. When changing cleanup logic, update daemon tests and make logs explicit enough to diagnose what was cleaned.

Internal transient bridges must refuse to start when a live daemon owns the workspace. If an endpoint is stale, clear it and continue using existing helper functions.

## WeChat, Attachments, And Transport
Inbound WeChat images and files are downloaded to `~/.cli-bridge/inbound-attachments/<date>/` and forwarded to the selected CLI as local paths in the prompt. This project saves and exposes attachment paths; it does not implement OCR or document parsing inside the bridge.

`sendmessage ret=-2` is a stale WeChat context-token condition, not a generic send failure. Preserve the targeted cache-clearing and user-facing guidance around sending a fresh WeChat message after startup or long idle periods.

Network failures to `https://ilinkai.weixin.qq.com` may be proxy-related even when bridge state is healthy. Node `fetch()` needs appropriate `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and often `NODE_OPTIONS=--use-env-proxy`; keep `NO_PROXY=127.0.0.1,localhost,::1` so local daemon/companion traffic stays direct.

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
2. Update `package.json` and `package-lock.json` to the target version.
3. Update `README.md` only for real workflow, install, migration, or compatibility changes. Keep README edits additive and preserve existing user-authored prose unless a broader rewrite is explicitly requested.
4. Add or update `docs/releases/<version>.md`, `docs/releases/<version>_CN.md`, and `docs/releases/README.md`.
5. Run `npm run quality`.
6. Run `npm pack --dry-run --json` and verify the tarball contains `bin/`, `dist/`, `README.md`, and `LICENSE.txt`, not `src/`, tests, local state, or `node_modules`.
7. Run `npm run smoke:global -- --purge-global --clean-cache`; use `--full` when validating the complete release path.
8. Run `npm publish --dry-run --access public`.
9. Run `npm run publish:dual -- --dry-run`.
10. Publish with `npm run publish:dual -- --otp <code>` when npm requests OTP, or without `--otp` when web auth is already valid.
11. Verify both registries:
```bash
npm view cli-wechat-bridge version dist-tags --registry=https://registry.npmjs.org/ --json
npm view @unlinearity/cli-wechat-bridge version dist-tags --registry=https://registry.npmjs.org/ --json
```
12. Only after live registry verification, update `log.md` and `git-log.md` if the user asks for double log entries.

If npm returns `EOTP`, `E401`, or `E404` during real publish, record it as an auth/registry blocker until registry reads prove otherwise. Dry-runs are validation, not publication.

## Commit And PR Guidance
Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `build:`, and `chore:`. Keep subjects imperative and behavior-focused, for example `fix: preserve daemon visible companion occupancy`.

PRs should describe:
- affected adapter(s) or runtime area;
- user-visible behavior change;
- migration or compatibility impact;
- commands run;
- relevant WeChat output or terminal snippets for approval, onboarding, daemon switching, or message formatting changes.

Before committing, inspect `git status --short --ignored`. Do not commit ignored local runtime state. If the user explicitly wants the double logs committed, force-add `log.md` and `git-log.md`.

## Troubleshooting Workflow For Agents
When behavior is unclear, inspect real state before changing code:
- `~/.cli-bridge/bridge.log` for bridge/daemon runtime events;
- `~/.cli-bridge/daemon-endpoint.json` for daemon ownership;
- `~/.cli-bridge/bridge.lock.json` for single-bridge ownership;
- `~/.cli-bridge/workspaces/<workspace-key>/bridge-state.json` for active adapter/session state;
- adapter-scoped companion endpoint files under the workspace state directory.

Missing WeChat replies usually reduce to one of these questions: did the active adapter emit `final_reply`; was the active turn WeChat-owned; did transport send fail; did stale context-token handling clear the right recipient token; or did daemon switching target a different cwd.

Prefer surgical fixes backed by focused tests. Avoid broad rewrites of adapter flow, transport state, or release docs unless the user explicitly asks for a larger redesign.
