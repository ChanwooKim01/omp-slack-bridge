# User Flows — pi-slack-bridge

This doc captures **user-facing flows**: what a person is trying to accomplish and
what they observe, *not* which internal handlers fire. Each flow becomes a test
scenario at the user level (behavioral), so regressions are caught as broken
user outcomes rather than as code-level mismatches.

## Flow template

```markdown
## FLOW-<id> — <short title>

**Actor:** who is doing this (e.g. Slack user, terminal user)
**Goal:** what they are trying to accomplish

### Steps (from the user's perspective)
1. ...
2. ...

### Expected outcome
What the user sees / can rely on.

### Acceptance criteria
- [ ] ...
- [ ] ...
```

## Worked example

## FLOW-001 — Send a message from Slack and get a reply

**Actor:** a Slack user chatting with the bot in a DM
**Goal:** ask the agent something and receive the answer in Slack

### Steps
1. User sends a message in the bot's DM.
2. The bot shows a ⏳ reaction while the agent is thinking.
3. The agent's reply arrives in Slack, formatted as Markdown.
4. The ⏳ reaction is removed when the reply is done.

### Expected outcome
The user gets a readable, formatted reply in the same DM, and sees
the working indicator clear when it's done.

### Acceptance criteria
- [ ] Message reaches the agent and a reply comes back to Slack
- [ ] Reply is formatted (Markdown, not raw)
- [ ] Working reaction appears while thinking and disappears when done
- [ ] Reply lands in the same thread/DM the user wrote in

---

## FLOW-002 — Push the terminal session to Slack (`/slk-bridge handover`)

**Actor:** pi user in the terminal
**Goal:** push the current terminal session's conversation into the trusted Slack user's DM, so they can read it and continue it from Slack

### Steps (from the user's perspective)
1. User runs `/slk-bridge handover` in the pi terminal.
2. If this session was opted out of takeover, it is auto-opted back in.
3. If Slack is not configured or not connected, the bridge connects first.
4. The conversation is pushed into a **fresh top-level thread** in the trusted user's DM:
   - header: `🔄 Terminal session pushed to Slack`
   - user messages prefixed `🗣️ **User:**`, assistant messages as-is
5. Two modes depending on whether the agent is busy:
   - **Idle:** history pushed immediately → `✅ Session pushed to Slack`
   - **Busy:** shows `⏳ Waiting for agent to finish...`, waits for the agent to finish, then pushes history + the final response → `✅ Session pushed to Slack`

### Expected outcome
The trusted Slack user has the whole session conversation in a new thread in their DM and can reply there to continue it.

### Acceptance criteria
- [ ] No trusted user authenticated → clear error, nothing sent (`No trusted user found. Authenticate a user first.`)
- [ ] Slack not configured → clear error (`Slack not configured. Run /slk-bridge configure first`)
- [ ] Idle with no history → `No conversation history to push`, nothing sent
- [ ] Idle with history → a new thread is created, history replayed in order (user msgs prefixed), delivery marked
- [ ] Busy → does not hang; completes with history + final response after the agent finishes
- [ ] Opted-out session is auto-opted in so handover works
- [ ] After handover, the pushed thread is the remembered thread for this session (replying in Slack routes back to it)

### Anti-regression requirements (pinned)
- **No duplicate final message.** In the busy case, the push is *history + final message*, and the final assistant message must appear **exactly once** in the thread. (Currently broken: `getConversationHistory` already contains the last assistant msg, then `finalResponse` posts it again → duplicated.)

> **Test status:** ✅ Covered by `tests/bridge/flow002-handover.test.ts` + `tests/helpers/bridge-harness.ts`. The test caught the duplication (red), and the fix in `agent_end` branch 2 (only post `finalResponse` when it isn't already the last pushed message) made it green.

### Open questions / risks
- The busy path's `handoverPending.reject` is never called anywhere — if the session is interrupted (ownership lost, disconnect, error) while waiting, the command may hang forever. Worth a regression test / fix.

---

## FLOW-003 — Continue the conversation from the pushed Slack thread

**Actor:** trusted Slack user
**Goal:** reply in the handover thread and have the agent pick it up and continue

### Steps (from the user's perspective)
1. After a handover, the trusted user replies in the new Slack thread.
2. The agent picks up the message and responds.
3. The reply arrives back in the same thread.

### Expected outcome
The conversation continues seamlessly from Slack: message in → immediate reply, in the same thread the user replied in.

### Acceptance criteria
- [ ] Reply in the handover thread is delivered to the agent **immediately** (no artificial delay)
- [ ] The message is ingested **exactly once** (no duplicate turns / double-processing)
- [ ] The agent's reply lands in the **same thread** the user replied in
- [ ] ⏳ reaction shows while working and clears when done

### Anti-regression requirements (pinned)
- **Immediate pickup:** a reply in the handover thread must reach the agent with no delay.
- **Single ingestion:** the message must be processed exactly once — no duplicate turns.

### Note
These two are currently *observed* regressions. Static code reading suggests the reply should already route back to the same session and call `sendUserMessage` once, immediately — so the real mechanism is behavioral (likely handler re-wiring, dedup, or the turn-accumulator). The behavioral test must fail on these so we can self-correct.

> **Test status:** ✅ Covered by `tests/bridge/flow003-continuation.test.ts` + the harness (`tests/helpers/bridge-harness.ts`). Three tests:
> 1. Happy-path continuation (idle handover → reply) — single ingestion, tagged prefix, no handoff. Green.
> 2. Busy-handover continuation (thread created at `agent_end` → reply) — same guarantees. Green.
> 3. **Concurrency/performance**: `agent_end` must NOT block on the sequential history push. This was RED (reproducing the real-system slowness: agent_end awaited all history sends inline, gating the next message), then fixed by backgrounding the replay (header awaited so the thread is remembered immediately; history fire-and-forget).
>
> The fix also surfaced a real bug: the background closure must capture `chatId` as a local value before `handoverPending` is nulled, or it throws mid-replay.

---

## FLOW-004 — Use several sessions from one Slack DM

**Actor:** trusted Slack user, with two or more OMP sessions (separate processes) running
**Goal:** talk to each session in its own thread, at the same time, without the bridge guessing which session a message is for

### Steps (from the user's perspective)
1. In each session the user runs `/slk-bridge connect`. Each session posts (or reuses) its own root thread in the DM. The first one to join also becomes the router and holds the Slack connection; later ones do not take it.
2. The user replies in session B's thread. The message reaches B's agent, and B's answer appears in B's thread — even though session A holds the Slack connection.
3. The user replies in session A's thread. It goes to A.
4. Session A runs `/slk-bridge disconnect` (or its process ends). Another joined session claims the Slack connection within a couple of seconds.
5. The user replies in A's thread again. The router answers in that thread that the session is not running.

### Expected outcome
Exactly one process holds the Slack connection at any time, every thread reaches the session that owns it, and a dead session is reported instead of its messages going to a different session.

### Acceptance criteria
- [ ] `/slk-bridge connect` never takes the router role from a live router; `/slk-bridge router` does
- [ ] A reply in another live session's thread is written to that session's inbox, handled there exactly once, and the file is removed
- [ ] A reply in a thread whose session is not running gets the "session is off" notice and is not handled by any session
- [ ] Top-level messages and replies in unowned threads are handled by the router session; `.bridge resume` stays with the router
- [ ] A router that loses the lock closes its socket, even when its local flag was already cleared
- [ ] A joined session that is not the router can post, react, upload and send question alerts; a session that has not joined is silent
- [ ] Concurrent writers never lose each other's updates to `slk-bridge.json`

> **Test status:** ✅ Covered by `tests/bridge/router-inbox.test.ts` (harness, fake lock), `tests/bridge/two-sessions.test.ts` (two bridge instances, real lock/config/registry/inbox), `tests/session/lock.test.ts` and `tests/config/update-config.test.ts` (real concurrent processes).

---

## FLOW-005 — Keep a long session thread short

**Actor:** trusted Slack user on a phone, talking to a session in its thread
**Goal:** reach the newest messages of a long thread without scrolling, without losing what the older ones said

### Steps (from the user's perspective)
1. The user keeps working with a session in its thread. Each message of the user plus the bridge's answers to it is one interaction.
2. After the answer to a Slack message is posted, the thread holds 10 or more interactions (`threadPruneAt`).
3. The thread shrinks by itself: its root message now shows `**<title>**`, a blank line, `📝 지난 대화 요약` and a short summary; only the newest 5 interactions (`threadKeep`) remain below it.
4. The user can steer it from the thread: `.bridge title <text>`, `.bridge new` (clear everything now), `.bridge keep <N>`, `.bridge pruneat <M>`.

### Expected outcome
The thread starts with a title and a summary of everything that was pruned, followed by the latest interactions. The summary never shows up as a normal reply, and the agent's own conversation is unchanged.

### Acceptance criteria
- [ ] Nothing is pruned below `threadPruneAt`, without a user token, while the session is working, while an `ask` question is pending in the thread, or in a thread the session does not own
- [ ] The oldest `count − threadKeep` interactions are summarized (merged with the stored summary) and deleted; the newest `threadKeep` and the thread root are never deleted
- [ ] If the summary cannot be made or written, nothing is deleted
- [ ] A hand-written root title (`[VLM_Verifier] MoT`) is kept as the title; a user-written root gets its summary in one bot message that is never pruned
- [ ] The user token only ever deletes the user's own replies in a thread of the paired DM; bot messages are deleted with the bot token
- [ ] `.bridge new` summarizes and deletes everything and answers once afterwards; its replies, like all command replies, can be pruned later

> **Test status:** ✅ Covered by `tests/slack/thread-history.test.ts`, `tests/slack/guarded-delete.test.ts`, `tests/bridge/thread-pruner.test.ts`, `tests/bridge/thread-settings.test.ts` and `tests/bridge/thread-pruning.test.ts` (a whole bridge against a fake Slack Web API).

---

_Add flows below. Number sequentially (FLOW-006, FLOW-007, ...)._
