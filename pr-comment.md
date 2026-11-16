## Implementation notes

Pins a WeChat/WeCom/Telegram conversation to a fixed local CLI window, so messages from that chat always reach the same window even while you switch windows elsewhere.

### Commands (daemon)
- `/pin` — pin the current chat to the currently active window
- `/pin codex-2` — pin to a named window (`codex` = instance 1, `codex-2` = instance 2, same for `claude`/`opencode`/`pi`); opens the window if it does not exist, rejects invalid names with `pin.invalidWindow`
- `/unpin` — remove the pin, messages fall back to active-window routing
- `/pins` — list pinned chats of this channel with their window names

### Design
- Bindings are per conversation (channel + remote user + conversation), stored in `~/.cli-bridge/pins.json` via a small atomic file store (`src/daemon/slot-pins.ts`), so pins survive daemon restarts
- `createFileSlotPins(path)` takes an injectable path (defaults to `PIN_BINDINGS_FILE`), which keeps the store unit-testable with a temp file; a corrupt file falls back to an empty map instead of crashing
- Inbound routing resolves pins *before* active-slot routing; a pinned message joins its bound window without stealing `active` — switching windows for other chats is unaffected
- Pin commands route in message order, so a pinned chat can still send control commands (`/cd`, `/model`, ...) through its own window

### Tests
16 pin tests in `test/daemon/wechat-daemon-pins.test.ts` (store persistence + corrupt-file fallback, window-name parsing boundaries, routing while pinned, unpin fallback, `/pins` output, cross-channel isolation). Full suite: 961/962; the single failure is the pre-existing `codex-visible-thread-proxy` "rejects unauthenticated visible-client connections" case, which points at an unreachable `ws://127.0.0.1:1` and only misbehaves on some Windows setups (same root cause as #52's note on Unix-socket `.sock` handling).

### Notes for the reviewer
- Implements the request in #52.
- On Windows, `scripts/e2e/run-e2e.mjs` talks to the harness via a Unix-socket `.sock` path, which `net.createConnection` cannot open on Windows — a pre-existing platform limitation unrelated to this PR; CI runs the quality gate on Linux/macOS/Windows and should stay green here.
- CI run is currently waiting for approval (first-time contributor), nothing failing.
