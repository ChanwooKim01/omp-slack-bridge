# omp-slack-bridge

**English** · [한국어](README.ko.md)

![omp-slack-bridge: one Slack DM, many OMP / Paseo agents, one thread each](media/banner.png)

A **pi extension** that connects your [Pi agent harness](https://github.com/earendil-works/pi-coding-agent) terminal session to Slack via Socket Mode.

This is a fork of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge) which purely focusses on the integration of Slack. It provides opinionated Quality-of-Life features like Markdown formatting via the [Slack Block Kit API](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/), tmux-backed Session Management (create new or switch to former Pi Session) and more.

Summarized featureset:
- Send messages, receive responses with pi from Slack
- Run deterministic remote commands (`/slk-bridge ...` in pi's terminal, `.bridge ...` in Slack DMs)
- Upload/download files between Slack and pi
- **Use several sessions at once from one Slack DM** — every joined session has its own thread, replies are routed to the session that owns the thread, and no LLM is involved in the routing (see [Multi-session architecture](#multi-session-architecture))
- Switch between sessions, spawn new ones, and hand over the active terminal session to Slack
- Session message replay - when resuming a session, prior conversation history is replayed into the Slack thread
- Opt sessions out of automatically claiming the Slack connection

## About this fork

This repository is the **OMP / Paseo multi-session fork** of [comsysto/pi-slack-bridge](https://github.com/comsysto/pi-slack-bridge) (version 0.3.0), which is itself the Slack-only fork of [tintinweb/pi-messenger-bridge](https://github.com/tintinweb/pi-messenger-bridge). It is not an unmodified upstream installation. All credit for the original bridge, its Slack Block Kit formatting, challenge authentication and tmux session management goes to the upstream authors listed in [Acknowledgements](#acknowledgements). The code stays under the original **MIT** license; keep the copyright notice in [LICENSE](LICENSE) when you copy or redistribute it.

What this fork changes:

- **Multi-session use.** Several OMP sessions — for example several [Paseo](#omp--paseo-notes) agents, each in its own `omp` process — can use the same Slack DM at the same time, one thread per session. Upstream bridges one session at a time and hands the connection to whichever session was used last.
- **OMP integration.** The built extension is loaded through `~/.omp/agent/extensions/pi-slack-bridge.ts`, state lives under `~/.omp/agent/`, and OMP `ask` questions are mirrored into the session's Slack thread.
- **Safer shared state.** Every write to `slk-bridge.json` is locked across processes and atomic, because several processes now share it.

## Multi-session architecture

Slack Socket Mode delivers each event to **exactly one** open connection per app token. So only one process on the machine may hold the connection: the **router**. Everything else is plain file I/O on the local disk.

```mermaid
flowchart LR
    Slack[("Slack DM<br/>one thread per session")]
    subgraph Host["one machine - ~/.omp/agent/"]
        R["Router session<br/>owns slk-bridge.lock<br/>holds the Socket Mode connection"]
        A["Session A<br/>joined"]
        B["Session B<br/>joined"]
        REG[("slk-bridge-sessions/<br/>one file per joined session")]
        IN[("slk-bridge-inbox/SHA1/<br/>one file per queued message")]
        CFG[("slk-bridge.json<br/>tokens, thread to session map, joined list")]
    end
    Slack -- "events (Socket Mode)" --> R
    R -- "reply in B's thread, B is alive" --> IN
    IN -- "B polls every 500 ms" --> B
    R -. "is the owner alive?" .-> REG
    R -. "who owns this thread?" .-> CFG
    A -- "messages, reactions, files (bot token only)" --> Slack
    B -- "messages, reactions, files (bot token only)" --> Slack
    R -- "same, for its own session" --> Slack
```

- **Join / leave.** `/slk-bridge connect` *joins* the current session: it registers the session, remembers the join in `slk-bridge.json` (so a restarted process for the same session rejoins on start), posts — or reuses — the session's root thread in the paired DM, and becomes the router **only if no live router exists**. `/slk-bridge disconnect` *leaves*: it unregisters, forgets the join, deletes queued messages, and releases the router role and the socket if this session holds them.
- **Router election.** The lock file `slk-bridge.lock` stays the single guard. Every joined session checks every ~2 s: if no live process owns the lock (a dead owner's lock is cleaned up by PID check), it claims the lock — an exclusive create, so simultaneous claimants cannot both win — and opens the socket. Joining never takes the role from a live router; `/slk-bridge router` does it explicitly. A router that loses the lock (taken over, or the local flag cleared) closes its socket within ~250 ms.
- **Registry.** `slk-bridge-sessions/<sha1(sessionPath)>.json` holds `{sessionPath, pid, instanceId, updatedAt}`. A session counts as running while that PID is alive; a joined session re-creates its record if it vanishes. (Liveness is a PID check, so if the operating system reuses the PID of a crashed session for another program, that session looks alive until it is restarted or leaves.)
- **Routing.** For every message the router receives (after the usual trusted-user filtering):

  | Message | Handled by |
  | --- | --- |
  | Reply in a thread owned by the router's own session | the router session |
  | Reply in a thread owned by **another live** session | that session, through its inbox (`slk-bridge-inbox/<sha1>/<ms>-<id>.json`, written atomically, polled every ~500 ms, deleted when read, de-duplicated by `chat:ts`) |
  | Reply in a thread owned by a session that is **not running** | nobody — the router answers in the thread: *"이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다."* |
  | Top-level DM message, or reply in a thread nobody owns | the router session, which then owns the new thread |
  | `.bridge resume ...` | the router, wherever it is written |

- **Posting needs no socket.** Replies, the ⏳ reaction, file uploads, mirrored answers and question/approval alerts use only the bot token (`@slack/web-api`), so any joined session can post whether or not it is the router. A session that has not joined stays silent.
- **Stale messages.** Queued messages older than 10 minutes are dropped when read, so a session that restarts late never acts on an old instruction.

### `autoConnect`

`autoConnect` (default **on**) decides only whether **joined** sessions claim a vacant router role on their own — at session start and on the 2-second check. It does not join anything, and `connect` / `disconnect` no longer change it. An explicit `/slk-bridge connect` claims the router role when no live router exists; `/slk-bridge router` takes it even from a live router. With `autoConnect` off — or for a session that ran `/slk-bridge optout` — a router that goes away is not replaced automatically: nobody receives from Slack until someone runs `/slk-bridge connect` or `/slk-bridge router`. Toggle it with `/slk-bridge autoconnect`.

### Commands for joining

| Command | Effect |
| --- | --- |
| `/slk-bridge connect` | Join this session (needs a session file, so send a message first in a brand-new session). Becomes router if none is live. |
| `/slk-bridge disconnect` | Leave. Releases the router role and the socket if held. |
| `/slk-bridge router` | Take the router role from the current router (joins first if needed). The old router closes its socket, then this session connects. |
| `/slk-bridge status` | Joined or not, who is router, whether this process has the socket open, `autoConnect`. |
| `/slk-bridge autoconnect` | Toggle automatic router claiming for joined sessions. |
| `/slk-bridge optout` / `optin` | Never / again auto-claim the router role in this session. |
| `.bridge status` / `connect` / `disconnect` (Slack) | The same, for the session that owns the thread you write in. `.bridge disconnect` confirms first, then leaves. |

`/slk-bridge handover` also joins the session (without posting a separate root, because the handover opens the thread).

### OMP / Paseo notes

- OMP loads the built extension through `~/.omp/agent/extensions/pi-slack-bridge.ts`, which re-exports `dist/bridge/index.js`. Rebuild with `npm run build` after source changes; a **new** OMP session picks the build up, running sessions keep the code they loaded.
- Each Paseo agent is its own `omp` process. Run `/slk-bridge connect` once in the agents you want on Slack; the join is remembered per session file, so reopening an agent in Paseo rejoins it. Subagents inside a process are not joined.
- OMP `ask` questions appear in the normal app UI and in the session's Slack thread. Reply in that thread with a choice number, its exact label, or free text; for several questions use one `question-id: answer` line per question. The first explicit answer wins and the other dialog is cancelled; late replies to a finished question never start a new turn. Cancellation or a missing answer is never approval.
- Native tool-permission requests may notify Slack, but their approval stays in Paseo/OMP. Slack replies do not bypass tool permissions.
- New question alerts mention only the configured trusted user. Phone push delivery depends on Slack and OS notification settings. Local alerts and final answers omit the prompt-preview footer.
- The upstream tmux/Pi session-spawning commands are not the supported Windows/Paseo workflow; use Paseo to create and switch sessions.
- Existing configured channel/user authorization is reused. File-transfer scopes are not enabled by this setup. Optional Slack user/channel metadata scopes are not required for text question replies.

## Setup

### 1. Install

```bash
pi install npm:pi-slack-bridge
```

Or install from local path:

```bash
pi install /path/to/pi-slack-bridge
```

For OMP, clone this fork into `~/.omp/agent/pi-slack-bridge` (`git clone https://github.com/ChanwooKim01/omp-slack-bridge.git ~/.omp/agent/pi-slack-bridge`), build it (`npm install && npm run build`), and create `~/.omp/agent/extensions/pi-slack-bridge.ts` containing `export { default } from "../pi-slack-bridge/dist/bridge/index.js";`.

### 2. Create the Slack app

You need a Slack app with **Socket Mode** and two tokens: a **Bot Token** (`xoxb-...`) and an **App-Level Token** (`xapp-...`). Socket Mode means the bridge opens an outgoing connection to Slack, so you do not need a public URL, a server or port forwarding.

#### Fast way: create the app from a manifest

1. Open <https://api.slack.com/apps> and click **Create New App**.
2. Choose **From a manifest**, then pick your workspace.
3. Select the **YAML** tab, replace the content with the manifest below, and click **Next** → **Create**.

   ```yaml
   display_information:
     name: oh-my-pi
     description: Talk to your OMP / Paseo agents from Slack, one thread per session
     background_color: "#1e1b4b"
   features:
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: oh-my-pi
       always_online: true
   oauth_config:
     scopes:
       bot:
         - chat:write
         - reactions:write
         - im:history
         - im:write
         - files:read
         - files:write
   settings:
     event_subscriptions:
       bot_events:
         - message.im
     interactivity:
       is_enabled: false
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```

   You can rename `oh-my-pi`. Drop `files:read` / `files:write` if you never send files between Slack and the agent.
4. **App-Level Token.** In **Settings → Basic Information → App-Level Tokens**, click **Generate Token and Scopes**. Give it any name, add the scope `connections:write`, click **Generate**, and copy the `xapp-...` token.
5. **Bot Token.** In **Settings → Install App**, click **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token** (`xoxb-...`).
6. **Icon (optional).** In **Settings → Basic Information → Display Information**, upload [`media/icon-512.png`](media/icon-512.png) as the app icon.

#### Manual way

If you prefer clicking through the settings, or you are fixing an existing app:

1. **Settings → Socket Mode:** turn on **Enable Socket Mode**. Slack asks for an App-Level Token with `connections:write`; create it and copy the `xapp-...` token.
2. **Features → App Home:** turn on **Messages Tab** and tick **Allow users to send Slash commands and messages from the messages tab**. Without this, you cannot DM the bot.
3. **Features → Event Subscriptions:** turn on **Enable Events**, open **Subscribe to bot events**, and add:
   - `message.im` — direct messages (the supported setup)
   - `message.channels` — public channels (only if you enable channels with `/enable`)
   - `message.groups` — private channels (same)
4. **Features → OAuth & Permissions → Bot Token Scopes:** add the scopes from the table below.
5. **Settings → Install App:** install (or **reinstall** after you changed scopes or events) and copy the `xoxb-...` token.

> After you change scopes or events, Slack shows a yellow "reinstall your app" banner. The change takes effect only after the reinstall.

#### Bot Token scopes

(in `Features > OAuth & Permissions`)

| Scope | Needed for |
| --- | --- |
| `chat:write` | posting every reply, alert and thread root |
| `reactions:write` | the ⏳ reaction while a prompt is processing |
| `im:history` | receiving DMs (`message.im`) |
| `im:write` | DM channel access for the bot (recommended alongside `chat:write`) |
| `channels:history`, `groups:history` | receiving channel messages (`message.channels` / `message.groups`); skip for a DM-only setup |
| `files:write` | uploading files to Slack (`send_slack_file`, `/slk-bridge sendfile`) — only if you use uploads |
| `files:read` | downloading files the user sends to pi — only if you use downloads |
| `im:read` | optional: DM metadata for session management (channel IDs starting with `D` are recognised without it) |
| `users:read` | optional: show display names instead of user IDs |

### 3. Give the tokens to the bridge

Configure the Slack Bridge via the interactive menu:

```bash
/slk-bridge
# Select "Configure"
# Enter bot token
# Enter app token
```

Or via CLI:

```bash
/slk-bridge configure <bot-token> <app-token>
```

Or set environment variables (never written to `slk-bridge.json`):

```bash
export PI_SLACK_BOT_TOKEN="xoxb-your-slack-bot-token"
export PI_SLACK_APP_TOKEN="xapp-your-slack-app-token"
```

### 4. Connect

```bash
/slk-bridge connect
```

This joins the current session (see [Multi-session architecture](#multi-session-architecture)). Joined sessions rejoin automatically when their process starts; whether they also claim the Slack connection on their own is controlled by `autoConnect` in `~/.omp/agent/slk-bridge.json`.

### 5. Authenticate a Slack User

1. In Slack, open the app's DM: click **Apps** in the sidebar (or search for the app name) and open its **Messages** tab.
2. Send any message, for example `hi`. The first time, the bridge answers with a request for a 6-digit challenge code. The code appears in the terminal of the router session (the session that holds the Slack connection).
3. Type the code into the DM. You are now the trusted Slack user for this bridge, and that DM becomes the paired chat.
4. From now on, each joined session posts its own root message in this DM. Reply **in the thread** of a session's root message to talk to that session.

> Only one Slack user is trusted at a time. After the first successful claim, other users are ignored until claiming is manually re-opened with `/slk-bridge releaseclaim` in a Pi terminal session.

## Main deviations from pi-messenger-bridge

### Slack as first-class transport

- **Change of semantics** - `msg-bridge` -> `slk-bridge` 
- **File Upload and Receive** - send and receive Files over Slack to/from your Pi Agent session
- **Markdown Formatting** - Slack messages are now properly formatted with Markdown Blocks
- **stop** - send `stop` in Slack to abort an agent turn. Inspired by [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)
- **Reflect pi status in Slack message footer** - each latest message has a Slack footer annotation which reflects the state of your Pi agent (current path, model, context window,...)

![markdown formatting screenshot](media/markdown-formatting-screenshot.png)

### tmux-backed Session Management

The goal is to pick up your Pi session from Slack or from the terminal whenever you want.
For this, `tmux` is used as the backbone to create new Pi sessions, switch to older ones or list previous ones.
Only one `tmux` session can exist at time to function as a container for a newly created or switched-to Pi session.

There are several main commands introduced:

- `/slk-bridge new [path]` - kill current Pi session and start a new one inside a tmux session. Include `path` as an optional argument to start the session in a path on your OS
- `/slk-bridge resume` - list the recent 10 sessions of your Pi agent.
- `/slk-bridge resume list [number]` - list the recent `number` sessions (default 10). Include an optional `number` argument to list the last `number` sessions.
- `/slk-bridge resume <number>` - resume a session denoted by the number in the `resume`/`resume list` output. The old tmux session (if it exists) gets used for switching the Pi terminal session.
- `/slk-bridge handover` - push the current terminal session into Slack so the conversation can continue there

Each command is implemented in a deterministic fashion inside the Pi Agent harness so that no LLM call is triggered.
To keep a local terminal session from claiming the Slack connection on its own, use `/slk-bridge optout` (and `/slk-bridge optin` to allow it again).

Every joined session gets its own thread in the DM with the Slack App bridged to your Pi agent. Replying in a session's thread reaches that session if it is running (see [routing](#multi-session-architecture)); otherwise you are told it is not running. The same thread-based flow is used when explicitly pushing a terminal session to Slack via `/slk-bridge handover`. When a session is pushed to Slack (handover), the full conversation history plus the final response are replayed into the new thread so the Slack user can pick up where the terminal left off.

### Deterministic Dot Commands

The user can use `.bridge` as a sort-of replacement to trigger some `/` commands to Pi. Currently only supports `skills` and `prompt templates` next to pi-slack-bridge native commands.
To list all available commands, send `.` in Slack.

![dot commands screenshot](media/dot-commands-screenshot.png)

## Security

- Config file: `~/.omp/agent/slk-bridge.json` (chmod 600 — owner read/write only; on Windows it relies on the directory/file ACL, see below)
- Config directory: `~/.omp/agent/` (chmod 700 — owner only)
- Router lock: `~/.omp/agent/slk-bridge.lock`; config write lock: `~/.omp/agent/slk-bridge.json.lock`
- Joined-session registry: `~/.omp/agent/slk-bridge-sessions/`
- Per-session inboxes (they hold the text of Slack messages): `~/.omp/agent/slk-bridge-inbox/`
- Downloads: `~/.pi/slk-bridge-downloads/slack/`
- Environment variables take precedence over file config and are never written back to the file
- Config updates are locked across processes, re-read under the lock and replaced atomically (temp file + rename); a config file that does not parse is never overwritten
- Challenge-based authentication (6-digit code, 3 attempts, 2-minute expiry)
- Transport-namespaced user IDs prevent impersonation
- Only one trusted Slack user is supported at a time; after the first successful claim, other users are ignored until claim is manually re-opened via `/slk-bridge releaseclaim`

> **Windows:** replacing the config file via rename gives the new file the ACL inherited from `~/.omp/agent/`, not an ACL that was set on the old file alone. The default profile ACL grants your user, SYSTEM and Administrators; tighten the ACL of the **directory** if that is wider than you want.

## Troubleshooting

Enable debug mode to see detailed logs:

```bash
export SLK_BRIDGE_DEBUG=true
```

Or set in config:

```json
{ "debug": true }
```

### Common Issues

- **Run `/slk-bridge status` first.** It shows whether this session is joined, who the router is, and whether this process holds the socket.
- **"Only one socket per app token."** Slack delivers each event to *one* of the connections open for an app token, chosen by Slack. If a second process — a session started with a different lock directory, another machine, an old bot process, a second tool using the same app-level token — holds a socket, events reach it at random and look lost. On one machine the router lock prevents this; across machines or tools it cannot. Use one app token per machine/tool, stop the other consumer, then run `/slk-bridge router` in the session that should receive.
- **No Slack messages received** — verify Socket Mode is enabled, both tokens are correct, `message.im` is subscribed, and `/slk-bridge status` shows a router. With `autoConnect` off nobody claims the router role on its own: run `/slk-bridge router`.
- **"이 스레드의 세션이 꺼져 있습니다…"** — the session that owns that thread has no running process. Open that agent in Paseo (or resume the session); a session you joined rejoins on start. Write in a thread of a running session, or top-level for the router session.
- **A reply goes to the wrong session** — replies follow the *thread*. Write in the thread of the session you mean; a top-level DM message goes to the router session.
- **"Another session is the router" but nothing is received** — that process may be stuck. Run `/slk-bridge router` to take over; the old router closes its socket within about a quarter of a second.
- **`Refusing to overwrite ...: it is not valid JSON`** — `slk-bridge.json` was damaged or edited by hand. The bridge never overwrites a file it cannot parse; fix or restore the JSON.
- **`Timed out waiting for the slk-bridge config lock`** — another process holds `slk-bridge.json.lock`. A lock older than 5 seconds is treated as left behind by a crash and broken automatically; if it persists with no `omp` running, delete the lock file.
- **Handover not working** — ensure a trusted Slack user has already claimed the bridge, since `/slk-bridge handover` needs a remembered Slack DM target.
- **Handoff not working** — ensure tmux is installed and `pi` is in your PATH. Handoff spawns `pi --session <target>` in tmux.

## Development

```bash
git clone https://github.com/ChanwooKim01/omp-slack-bridge.git
cd omp-slack-bridge
npm install
npm run build        # compile TypeScript
npm run typecheck    # type-check without emitting
npm run test         # run vitest suite
npm run lint         # biome lint
npm run lint:fix     # biome lint with auto-fix
```

### Load directly from source (faster for development)

```bash
pi -e src/bridge/index.ts
/slk-bridge connect
```

### Test suite

```bash
npm run test
```

Covers config loading and cross-process-safe updates, the router lock (including simultaneous claimants in separate processes), the session registry and inbox, inbound routing, outbound posting without a socket, two sessions sharing one DM end to end, Slack block splitting, conversation history extraction, and formatting. A few tests start real Node processes to exercise the file locks; they take a few seconds.

## Acknowledgements

First of all, thanks to the tremendously useful Pi project by Earendil.

Thanks to [@tintinweb](https://github.com/tintinweb) for providing the `pi-messenger-bridge` extension this builds upon, and to the authors of [comsysto/pi-slack-bridge](https://github.com/comsysto/pi-slack-bridge), the Slack-only fork this multi-session fork is based on.
Furthermore thanks to [@badlogic](https://github.com/badlogic) and [@llblab](https://github.com/llblab) for their `pi-telegram-bridge` implementations that inspired some features in this extension like Markdown formatting.

Finally, thanks to [@antirez](https://github.com/antirez) for providing the `ds4` inference engine that enabled substantial development with a local `deepseek-v4-flash`.

## Transparency about coding agent use

This project used the Pi Agent Harness with the `gpt-5.4` model in the beginning to establish the Slack-only focus. Later, new features, refinements and refactors heavily took advantage of a locally hosted `deepseek-v4-flash` via [antirez/ds4](https://github.com/antirez/ds4) on a Macbook Pro M3 Max. The OMP / Paseo multi-session changes in this fork were also developed with coding-agent assistance.

## License

MIT
