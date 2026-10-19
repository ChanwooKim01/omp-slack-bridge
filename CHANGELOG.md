# Changelog

## Local OMP adaptation — unreleased

### Documentation and branding

- README: step-by-step Slack app setup, including a ready-to-paste app manifest and the manual settings path.
- Korean README (`README.ko.md`) with an English/Korean switch at the top.
- Project banner (`media/banner.svg`, `media/banner.png`) replaces the upstream screenshot as the README hero image; app icon (`media/icon.svg`, `media/icon-512.png`) for the Slack app.

### Multi-session router and inbox

Several OMP sessions (for example Paseo agents, each its own `omp` process) can now use one Slack DM at the same time, one thread per session, with no LLM relay. Slack delivers each Socket Mode event to one open connection per app token, so exactly one process — the router, the owner of `slk-bridge.lock` — holds the socket; it hands thread replies to the owning session through a per-session inbox.

**Added**
- **Join / leave.** `/slk-bridge connect` joins the current session: registers it, remembers the join in `slk-bridge.json` (`joinedSessions`) so a restarted process for the same session rejoins on start, posts or reuses the session's root thread in the paired DM, and becomes the router only if no live router exists. `/slk-bridge disconnect` leaves: unregisters, forgets the join, deletes queued messages, and releases the router role and the socket if held. `.bridge connect|disconnect|status` work the same from Slack.
- **`/slk-bridge router`** takes the router role from a live router explicitly. Joining never does.
- **Router election.** Every joined session checks every ~2 s and, when no live process owns the lock, claims it and opens the socket. A router that loses the lock closes its socket within ~250 ms, also when the local flag was already cleared. Failed automatic claims back off (up to 60 s) instead of retrying every tick.
- **Session registry** `~/.omp/agent/slk-bridge-sessions/<sha1(sessionPath)>.json` (`{sessionPath, pid, instanceId, updatedAt}`), written on join and on session start/switch, removed on leave and shutdown; a session is live while its PID is alive. A joined session re-creates its record if it vanishes.
- **Inbox** `~/.omp/agent/slk-bridge-inbox/<sha1>/<ms>-<id>.json`. For a thread reply owned by another live session the router writes the message atomically and stops; the owner polls every ~500 ms, deletes each file when read, de-duplicates by `chat:ts`, and feeds it into the normal Slack path (questions, remote commands, ⏳ reaction, follow-up while busy). Messages older than 10 minutes are dropped when read.
- **Offline notice.** A reply in a thread whose session is not running gets *"이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다."* in that thread; it replaces the old "이전 세션의 스레드입니다…" notice. `.bridge resume` is still handled by the router wherever it is written.
- **Posting without the socket.** `@slack/web-api` is now an explicit dependency; `SlackClient` posts messages and threads, adds and removes reactions and uploads files with the bot token alone. Replies, reactions, uploads, mirrored answers and question/approval alerts work for any joined session; a session that has not joined stays silent.
- **`updateConfig(mutator)`** replaces raw read-modify-write of `slk-bridge.json`: cross-process lock file (exclusive create, short backoff, stale-lock recovery), re-read under the lock, atomic temp-file + rename write. It never writes when the file does not parse and never persists `PI_SLACK_*` environment tokens. All writers (thread routing, auth, `autoConnect`, opt-out list, join list, widget and tool-call toggles, menu configure) use it.
- Tests: routing decision, inbox consume-once, registry, `updateConfig` with real concurrent processes, simultaneous router claimants in real processes, lock loss, join/leave/election, outbound posting without a socket, and two full bridge instances sharing one DM (`tests/bridge/router-inbox.test.ts`, `tests/bridge/two-sessions.test.ts`).

**Changed**
- `acquireLock()` now claims a vacant lock with an exclusive file create, so two processes claiming at the same moment cannot both win. `isProcessAlive` is exported.
- `autoConnect` (default on) only decides whether joined sessions claim a vacant router role on their own; `connect`/`disconnect` no longer flip it. `optedOutSessions` now means "never auto-claim the router role".
- Ownership checks no longer gate posting: the Paseo question/approval callback, mirrored answers, the ⏳ reaction, file upload and the turn/agent-end flush check *joined*, not *router*. Only receiving from Slack requires the lock.
- The paired DM is read from the config file, so a session that started before pairing or revocation never posts to a stale chat. A process that becomes router refreshes its trust state from the config (`ChallengeAuth.loadFromConfig` now replaces state).
- `/slk-bridge status`, the menu status line, the widget (`● slk router` / `● slk` / `○ slk`) and the help text show join and router state.

**Removed**
- The `input` hook that took over the Slack connection on every interactive/RPC input, and the takeover handover notice (`🔄 Session changed` plus history replay).
- `saveConfig` (replaced by `updateConfig`), the unused cross-session tmux handoff writer and its handoff directory creation, `getSlackHandoverReasonText`. `/slk-bridge connect user-request` still works; the argument is ignored.

**Fixed**
- Orphan Socket Mode connections: the previous client is disconnected before it is replaced on `/slk-bridge configure`, menu reconnect and a repeated `session_start`; membership timers are cleared on session start, switch and shutdown; a failed connect now disconnects instead of only releasing the lock.
- Concurrent processes no longer lose each other's updates to `slk-bridge.json`, no longer wipe tokens after reading a half-written file, and no longer write environment-provided tokens into it.
- Timers and detached promises cannot throw into the host: every background task reports failures instead (an uncaught throw would take the whole OMP session down).

> Windows: replacing the config file by rename gives it the ACL inherited from `~/.omp/agent/` instead of an ACL set on the old file alone.

### Earlier OMP adaptation changes

- Post one top-level root per session (`📁 project (branch) · path` plus the first prompt) and send that session's question alerts and permission notices as owner-mentioned replies in its thread, so parallel sessions no longer pile up top-level messages.
- Resolve the remembered thread from the persisted per-session mapping only; the old chat-keyed in-memory cache could reuse a previous session's thread after `/new`, `/resume`, or a branch. Alerts pin the session that raised them, so a session switch mid-post cannot remap the thread.
- Apply the "previous session's thread" guard to channels as well as DMs, and keep that thread owned by its session when the notice is sent, so a reply in another session's thread never becomes the active session's prompt.
- Omit prompt-preview footers from local alerts/answers, and disable automatic history replay on session takeover.

- Add an OMP question adapter: keep the normal app dialog and send the same question to Slack; accept the first explicit answer and cancel the competing dialog.
- Ignore late answers (option number, option label, or `id: answer`) to a closed question in its thread and say so; ordinary messages in the shared session thread still reach the agent. A Slack reply answers a pending question only if it was posted after that question's alert. Cancel decisions on session changes instead of granting implicit approval.
- Reuse the configured trusted user/channel, retain channel thread IDs without optional metadata permissions, and suppress duplicate message deliveries within the running connection.
- Store the local OMP bridge configuration and lock under `~/.omp/agent/`; use Windows ACL protection rather than interpreting POSIX mode bits as Windows permissions.
- Use Paseo, not tmux/Pi commands, for Windows session management. (The upstream single-active-session model no longer applies: see "Multi-session router and inbox" above.)


## [0.3.0] - 2026-08-18

### Added
- **Terminal-to-Slack handover** — `/slk-bridge handover` pushes the active terminal session into Slack and continues the conversation there
- **Connect/handover test coverage** — added tests for `connect` and `handover` flows
- **Behavioral test harness** — `tests/helpers/bridge-harness.ts` drives the bridge lifecycle via captured `pi.on` handlers and asserts on what is actually pushed to Slack; covers FLOW-002 (handover) and FLOW-003 (continuation) in `tests/bridge/`

### Changed
- **Single trusted user routing** — notification delivery and handover targeting now use one remembered trusted Slack user/DM instead of arrays of notification chat IDs
- **Session takeover flow** — connecting from another session now performs a cleaner handover of the active Slack connection
- **Resume semantics** — `list-sessions`/`switch` replaced by `resume`; `.bridge resume` lists recent 10, `.bridge resume list [number]` lists more, and `.bridge resume <number>` resumes a session (same global-index behavior as the old `switch`)

### Fixed
- **Handover robustness** — improved behavior around takeover/connect sequencing and session ownership transitions
- **Handover final-message duplication** — a busy handover (`/slk-bridge handover` during an agent loop) no longer posts the final assistant message twice: `getConversationHistory` already includes it, so the separate final-response send is skipped when it equals the last pushed message
- **Busy handover blocks next message** — `agent_end` no longer awaits the whole sequential history push; the replay is backgrounded (header awaited so the thread is remembered immediately), so pi can process the next Slack message without waiting for dozens of Slack API calls. The background closure captures `chatId` locally so it survives `handoverPending` being nulled
- **Slow startup** — `session_start` no longer blocks pi readiness on the Slack connection: auto-connect now runs as a background task (lock is still acquired synchronously), and `SlackClient.connect()` fails fast after a 10s timeout instead of hanging on an unreachable Slack (the underlying socket-mode client retries `apps.connections.open` with exponential backoff)

## [0.2.0] - 2026-07-16

### Added
- **Session replay module** — extracted reusable replay logic into `src/session/replay.ts`; `.bridge replay` command replays full conversation history into Slack thread
- **Toggle Tool Calls** — `/slk-bridge toggletools` and `.bridge toggletools` to hide/show tool call summaries in remote messages; replaces the old Widget toggle in the main menu
- **Toggle Auto Connect** — `/slk-bridge autoconnect` subcommand and menu option to disable automatic bridge takeover on session switch
- **Message count in session list** — `.bridge list-sessions` and `/slk-bridge list-sessions` now show message count per session

### Changed
- **Single trusted user** — `trustedUsers[]` array replaced by single `trustedUser` string; `adminUserId` removed; claim system simplified to one trusted user at a time
- **Main menu** — Widget toggle replaced by Toggle Tool Calls; added Toggle Auto Connect, Opt out, Opt in, and Help options
- **Remote command list** — `.bridge toggletools` listed in available commands
- **Trusted user display** — now shows Slack display name instead of raw user ID in status, `/trusted`, `/revoke`, and menu

### Fixed
- **Menu configure flow** — no longer leaves bridge `slackClient` null after configuration
- **`.bridge replay`** — no longer sends a header message count — just replays the messages
- **Challenge prompt wording** — rephrased from "provided by the bot admin" to "provided in your active Pi terminal session" so users know where to look for the 6-digit code
- **Unused imports** — cleaned across all source files; redundant switch cases removed

## [0.1.0] - 2026-07-14

### Added
- **Pure Slack fork** — removed all non-Slack transports (Telegram, WhatsApp, Discord, Matrix) and their interface/manager abstractions
- **Slack Block Kit formatting** — `src/slack/blocks.ts` converts markdown to Slack's native markdown blocks with smart splitting that keeps tables, code blocks, and lists intact
- **tmux-backed session management** — `src/session/tmux.ts` spawns new pi sessions; `list-sessions`/`switch` commands navigate recent sessions; each session gets its own Slack thread
- **Thread-to-session routing** — `src/slack/routing.ts` persists thread↔session mapping in config so continuing a Slack thread resumes the right session
- **Bridge takeover with opt-out** — sessions can opt in/out of automatic bridge takeover; force-acquire mechanism for manual override
- **Claim management** — after first auth, new DM claims stay closed until `/slk-bridge releaseclaim` is called; user chats remembered for notification routing
- **Turn response accumulation** — messages accumulate during a turn and flush at `agent_end`, avoiding fragmented Slack messages
- **Session handoff with replay** — handoff files in `~/.pi/slk-bridge-handoffs/`, background replay that doesn't block pi input, full conversation history on handover
- **Status footer** — simplified bridge status shown in pi's footer line via `setStatus` instead of a widget block
- **Dot commands** — `.bridge` remote commands for skills, prompt templates, and native bridge commands
- **File upload/download** — Slack files saved to `~/.pi/slk-bridge-downloads/slack/`, file uploads from bridge to Slack
- **New commands**: `/slk-bridge new [path]`, `/slk-bridge list-sessions [number]`, `/slk-bridge switch <number>`, `/slk-bridge optout`, `/slk-bridge optin`, `/slk-bridge releaseclaim`, `/slk-bridge accept-handoff`

### Changed
- **Command namespace**: `/msg-bridge` → `/slk-bridge`
- **Config file**: `~/.pi/msg-bridge.json` → `~/.pi/slk-bridge.json`
- **Environment variables**: `MSG_BRIDGE_DEBUG` → `SLK_BRIDGE_DEBUG`
- **Project structure**: flat multi-transport layout → DDD structure (`bridge/`, `slack/`, `session/`, `auth/`, `config/`, `types/`, `ui/`)
- **Auth**: simplified from transport-scoped claim maps to a single `claimOpen` boolean; user IDs no longer namespaced
- **Lock guard**: moved to `src/session/lock.ts` with force-acquire and ownership timer
- **Status widget**: simplified from widget block to footer line via `setStatus`
- **Config persistence**: added `slackRouting` state (thread mappings, delivery tracking)

### Removed
- All non-Slack transports (Telegram, WhatsApp, Discord, Matrix) and their interface/manager abstractions
- `src/formatting.ts`, `src/lock.ts`, `src/types.ts`, `src/index.ts` — replaced by Slack-specific equivalents
- `transport` abstraction layer — all transport parameters, branching checks, and namespacing removed
- 12000-char pre-split optimization — `sendMessageInThread` handles splitting natively
- Legacy `msg-bridge` fallback paths and dead code

### Fixed
- `slk-bridge` command registration (was still `msg-bridge` in source after rename)
- Session handover replay now fires as background task to unblock pi input processing
- Context window token formatting consistent with pi TUI footer
- Remaining `msg-bridge` references renamed across all source files

[unreleased]: https://github.com/comsysto/pi-slack-bridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/comsysto/pi-slack-bridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/comsysto/pi-slack-bridge/releases/tag/v0.1.0
