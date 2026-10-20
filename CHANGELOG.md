# Changelog

## Local OMP adaptation — unreleased

### Keeping threads short

Long session threads are slow to scroll on a phone. Each session thread now keeps only its latest interactions; everything older is replaced by an agent-written summary at the top of the thread and deleted. An *interaction* is one message of the trusted user plus the bridge messages that follow it until the next user message (bridge messages before the first user message form a leading interaction).

**Added**
- **Automatic pruning.** After a Slack-originated turn has been flushed to its thread, the session that owns the thread counts the thread's interactions. At `threadPruneAt` (default 10) or more, all but the newest `threadKeep` (default 5) are summarized — the stored summary and the text of those interactions are merged into one short Korean bullet summary — the summary is written into the thread header, stored in `slk-bridge.json` (`slackRouting.threadMeta["chat:threadTs"]`: `title`, `summary`, `summaryTs`, `updatedAt`), and only then are the summarized messages deleted. The thread root and the newest `threadKeep` interactions are never deleted. Large backlogs are summarized in rounds of about 48,000 characters.
- **Header.** A bridge-written root becomes `**<title>**`, a blank line and `📝 지난 대화 요약` with the summary (a markdown block, like every bridge post, with the markdown as `text` fallback). The title is the stored one, else the first line of the root with emoji and markup stripped; a hand-written root such as `[VLM_Verifier] MoT` keeps its text. When the user wrote the root (a bot cannot edit it), the thread's earliest bot reply is edited into the summary message and never pruned; `.bridge title` on such a thread posts one summary message when none exists.
- **Summary through an OMP side turn** (`ctx.runEphemeralTurn`, documented in OMP's extension API as the `/btw` pipeline). It uses the session's current model, adds neither the request nor the reply to the agent's conversation, and nothing is posted to Slack for it: the side turn runs outside the agent loop, so it never reaches the `message_end` mirror (there is no suppression logic that could swallow a real reply). The call sets no `tools: false` (keeps the prompt cache warm) and no `maxTokens` (some transports reject it); the model is told to answer with the summary text only, and the reply is trimmed to about 1,500 characters at a line boundary. The summarizer reads the **complete** text of everything that will be deleted: a long message is split over several rounds (about 48,000 characters each, every round merging into the running summary), never shortened. There is no hidden-turn fallback: a host without `runEphemeralTurn` cannot summarize, so it prunes nothing.
- **Guarded deleter** (`src/slack/guarded-delete.ts`) — the only module that reads the Slack user token and the only code that calls `chat.delete`. It deletes one message only when the channel is the paired DM (and a real DM channel for the user token), the message is a reply of the given thread (never the root; a top-level DM message has no `thread_ts` and is refused), the message was written by the token's own identity (`auth.test`, cached), and — for the user token — that identity is the trusted Slack user and the message is not a bot message. Anything else is refused with a `DeleteRefusedError` before any request is sent. Bot messages are deleted the same way with the bot token. Deletions are sequential, one per second, and retried on Slack's rate limit using Retry-After (the Web API client rejects rate-limited calls so the retry is visible); a message that is already gone counts as deleted.
- **Config.** `slack.userToken` (user token `xoxp-…` with the user scope `chat:write`; also `PI_SLACK_USER_TOKEN`, never written to the file), `threadKeep` (default 5, 1–50) and `threadPruneAt` (default 10, must exceed `threadKeep`). `/slk-bridge configure <bot-token> <app-token> [user-token]` and the menu's Configure accept the optional user token; reconfiguring without it keeps the stored one. `/slk-bridge status` shows the pruning settings and whether a user token makes automatic pruning possible. Without a user token nothing is pruned automatically; the session says so once.
- **Commands**, in Slack (`.bridge ...`, run by the session that owns the thread) and in the terminal (`/slk-bridge ...`, for the current session's thread): `title <text>` (works without a user token), `new` (summarize and delete every interaction up to the command, then answer; a ⏳ reaction on the command shows that it works, and whatever was written after the command stays and still reaches the agent; refuses without a user token or while the session is busy), `keep <N>` (also resets the threshold to `max(2N, N+1)`) and `pruneat <M>` (M must exceed the number kept). Their replies are ordinary thread messages and are pruned later like the rest.
- **Safety.** A failed read, summary or header write deletes nothing; a failed deletion stops the run and leaves the rest for the next one. Nothing is pruned while the session is mid-turn, while an `ask` question is pending in the thread (`isPending` on the question adapter), or in a thread the session does not own; one thread is pruned at a time. The session is checked again between summary rounds and right before every deletion request — after the pacing wait and after each Retry-After wait — and the run stops there if it got busy, was asked a question or moved on (the rest waits for the next run; an interrupted run is not a failure). The guarded deleter also re-validates channel, thread and author before every request, retries included. Only history up to a bound is touched: `.bridge new` takes messages up to the command itself (terminal: the Slack ts of the moment of the command) and an automatic prune up to the message of the turn it follows, so messages that are still on their way to the agent are neither summarized nor deleted. The user token is checked before the summary is requested (Slack accepts it and it belongs to the trusted user), so a revoked or foreign token costs no summary; after any failed automatic prune past the read, that thread is not retried automatically for 5 minutes (`.bridge new` is not held back).
- Tests: thread grouping, prune selection and header text (`tests/slack/thread-history.test.ts`), guarded-deleter refusals, rate limits and source invariants (`tests/slack/guarded-delete.test.ts`), the pruner against an in-memory DM thread (`tests/bridge/thread-pruner.test.ts`), settings and commands (`tests/bridge/thread-settings.test.ts`), and a whole bridge pruning a thread through a fake Slack Web API that enforces per-token permissions (`tests/bridge/thread-pruning.test.ts`).
- Live smoke verification (OMP 18.12.2, GPT-6.1 Sol): in a disposable Slack DM thread, automatic pruning replaced two older user messages with a header summary while preserving the newest question and answer. `.bridge title` preserved that summary, and `.bridge new` summarized and deleted the remaining interaction. The summary was not posted as an ordinary assistant reply. Test settings were restored to keep 5 / prune at 10, and the disposable agent and thread were cleaned up.

**Changed**
- `.bridge new` / `/slk-bridge new` **without a path** now clears the thread as described above. With a path (`new <cwd>`) it still starts a fresh tmux bridge session.
- `SlackClient` gained `getBotIdentity`, `fetchThreadMessages` (all pages of `conversations.replies`, or the root only), `updateMessage` (text and blocks) and `postThreadReply`; it still receives only the bot and app tokens. The shared Slack error helpers moved to `src/slack/errors.ts`.
- Documentation: README sections "Keeping threads short" / "스레드 짧게 유지하기", the manifest with `user: [chat:write]`, the User Token Scopes step of the manual setup, and the security notes — a user token can act as the user across the workspace in Slack's model; the bridge restricts it in code, and it is stored in `slk-bridge.json` (0600) like the other tokens.

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
