/**
 * pi-slack-bridge extension
 * Bridges Slack into pi — a pure Slack remote control surface for the pi coding agent.
 *
 * Architecture:
 *   bridge/index.ts   — Extension lifecycle wiring (session membership, router election, message routing, command registration)
 *   slack/client.ts   — Slack API client (Socket Mode receiving for the router; Web API posting, reactions and uploads for every joined session)
 *   slack/routing.ts  — Thread-to-session mapping state and the inbound routing decision
 *   slack/blocks.ts   — Markdown → Slack Block Kit conversion
 *   slack/formatting.ts — Message splitting, truncation, tool call formatting
 *   session/lock.ts   — Router lock (global flag + PID lock file): its owner holds the one Slack socket
 *   session/registry.ts — Registry of joined sessions (one file per session, liveness = PID alive)
 *   session/inbox.ts  — Per-session inbox the router uses to hand messages to another session's process
 *   session/tmux.ts   — Tmux session spawning for fresh bridge sessions
 *   session/handlers.ts — Session-level helpers (conversation history, footer text, session listing)
 *   session/replay.ts   — Message replay engine for session handoff
 *   auth/challenge.ts — Challenge-based user authentication
 *   config/index.ts   — Config loading and cross-process-safe updates (env vars override the file)
 *   util/atomic-write.ts — Atomic file replacement and synchronous sleep
 *   types/index.ts    — Shared type definitions
 *   bridge/commands.ts — Shared command definitions (status text, help text, remote command list)
 *   ui/main-menu.ts   — Interactive TUI main menu
 *   ui/status-widget.ts — Status widget
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import { Type } from "typebox";
import { ChallengeAuth } from "../auth/challenge.js";
import { loadConfig, updateConfig } from "../config/index.js";
import {
  buildSessionListText,
  buildSlackFooterText,
  buildSlackSessionRootText,
  getConversationHistory,
  getLastAssistantMessageInfo,
  listRecentSessions,
} from "../session/handlers.js";
import { clearInbox, drainInbox, enqueueInboxMessage } from "../session/inbox.js";
import {
  acquireLock,
  forceAcquireLock,
  getInstanceId,
  getLockOwner,
  isCurrentLockOwner,
  isLockHeldLocally,
  releaseLock,
} from "../session/lock.js";
import { ensureRegistered, isSessionLive, registerSession, unregisterSession } from "../session/registry.js";
import { buildTmuxConnectSummary, resolvePathInput, runTmuxPiConnect } from "../session/tmux.js";
import { SlackClient } from "../slack/client.js";
import {
  extractTextFromMessage,
  formatToolCalls,
} from "../slack/formatting.js";
import {
  decideInboundRoute,
  getRememberedSlackThreadForCurrentSession,
  getSlackThreadOwnerSession,
  hasLatestAssistantBeenDeliveredToSlackThread,
  isExplicitRemoteResumeCommand,
  markLatestAssistantDeliveredToSlackThread,
  rememberSlackThreadForSession,
  SESSION_OFFLINE_NOTICE,
} from "../slack/routing.js";
import type { ExternalMessage, PendingRemoteChat } from "../types/index.js";
import { openMainMenu } from "../ui/main-menu.js";
import { createStatusWidget } from "../ui/status-widget.js";
import {
  type BridgeStatus,
  buildBridgeHelpText,
  buildBridgeStatusText,
  buildRemoteCommandList,
} from "./commands.js";
import { installPaseoQuestions } from "./paseo-questions.js";

/** Cadence of the three checks every joined session runs. */
const OWNERSHIP_CHECK_MS = 250;
const ELECTION_CHECK_MS = 2_000;
const INBOX_POLL_MS = 500;
/** How long a forced router takeover waits for the previous router to close its socket. */
const TAKEOVER_SETTLE_MS = 350;
/** Per-step cap while leaving the bridge: hosts give session_shutdown handlers about two seconds. */
const SHUTDOWN_STEP_BUDGET_MS = 1_500;
const MAX_CLAIM_BACKOFF_MS = 60_000;
const NOTICE_REPEAT_MS = 60_000;
/** Inbox messages remembered for de-duplication by chat:ts. */
const SEEN_INBOX_LIMIT = 4096;

/** Wait for `work`, but never longer than `ms`; a failure of `work` is ignored. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  const cancelTimeout = new AbortController();
  await Promise.race([
    work.catch(() => undefined),
    sleep(ms, undefined, { signal: cancelTimeout.signal }).catch(() => undefined),
  ]);
  cancelTimeout.abort();
}

export default function (pi: ExtensionAPI): void {
  let slackClient: SlackClient | null = null;
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;
  /** Session file this runtime joined to the bridge; undefined while the session is not part of it. */
  let joinedSessionPath: string | undefined;
  let membershipTimers: NodeJS.Timeout[] = [];
  let membershipChange: Promise<void> = Promise.resolve();
  /** Bumped on every join and leave, so work accepted under an earlier membership can tell it is stale. */
  let membershipGeneration = 0;
  let membershipStopping = false;
  /**
   * This runtime acquired the router lock and has not released it. Tracked per runtime because the
   * lock flag is process-wide: a sibling extension instance in the same process must not release it.
   */
  let routerLockHeld = false;
  let routerClaim: Promise<boolean> | null = null;
  let claimBackoff = { notBefore: 0, delayMs: 0 };
  let ownershipCheckInProgress = false;
  let inboxQueue: Promise<void> = Promise.resolve();
  const seenInboxMessages = new Set<string>();
  const lastNoticeAt = new Map<string, number>();
  const sessionRootPosts = new Map<string, Promise<string | undefined>>();
  let activeSlackReaction: { chatId: string; messageId: string } | null = null;
  let turnAccumulator: {
    chatId: string;
    entries: string[];
    threadId?: string;
  } | null = null;
  let handoverPending: {
    chatId: string;
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  const questions = installPaseoQuestions(pi, async (text, target) => {
    if (!canPost()) return undefined;
    const chatId = target?.chatId ?? notificationChatId();
    if (!chatId) return undefined;
    // Pin the session at alert time so a session switch mid-post cannot remap this thread.
    // Replies into an existing question thread keep that thread's owner, which may be an earlier session.
    const sessionPath = (target && getSlackThreadOwnerSession(chatId, target.threadId)) || getCurrentSessionFile();
    let threadId = target?.threadId;
    let notification = text;
    if (!threadId) {
      threadId = sessionPath ? await ensureSessionThread(chatId, sessionPath) : undefined;
      const owner = loadConfig().auth?.trustedUser?.split(":")[0];
      if (owner && /^[UW][A-Z0-9]+$/.test(owner)) notification = `<@${owner}> ${text}`;
    }
    let postedTs: string | undefined;
    const postedThreadId = await sendToRemoteChat(chatId, notification, {
      ...(threadId ? { threadId } : { forceTopLevel: true }),
      noFooter: true,
      rememberThreadForSessionPath: sessionPath,
      onPosted: ts => { postedTs = ts; },
    });
    return postedThreadId ? { chatId, threadId: postedThreadId, postedTs } : undefined;
  });

  /** One top-level root per session; concurrent alerts share a single in-flight root post. */
  async function ensureSessionThread(chatId: string, sessionPath: string): Promise<string | undefined> {
    const existing = getRememberedSlackThreadForCurrentSession(chatId, () => sessionPath);
    if (existing) return existing;
    const key = `${sessionPath}:${chatId}`;
    let post = sessionRootPosts.get(key);
    if (!post) {
      post = (async () => sendToRemoteChat(chatId, await buildSlackSessionRootText(ctx), {
        forceTopLevel: true,
        noFooter: true,
        rememberThreadForSessionPath: sessionPath,
      }))();
      sessionRootPosts.set(key, post);
      void post.catch(() => {}).finally(() => sessionRootPosts.delete(key));
    }
    return post.catch(() => undefined);
  }

  // ── Short-lived helpers (bridge state accessors) ──────────────────────────

  function getCurrentSessionFile(): string | undefined {
    try {
      return ctx.sessionManager.getSessionFile();
    } catch {
      return undefined; // the session context is gone or not yet bound
    }
  }

  /** This process holds the router lock, so it alone may hold the Slack socket and receive from Slack. */
  function ownsBridgeConnection(): boolean {
    return isLockHeldLocally() && isCurrentLockOwner();
  }

  function hasConfiguredSlack(): boolean {
    return slackClient !== null;
  }

  /** The Slack socket is open. Only the router's is. */
  function slackIsConnected(): boolean {
    return slackClient?.isConnected ?? false;
  }

  function isJoined(): boolean {
    return joinedSessionPath !== undefined;
  }

  /** One join of one session. Work accepted under it is void once that session leaves or the process switches sessions. */
  interface Membership {
    sessionPath: string;
    generation: number;
  }

  /** The membership in force right now; none while the session has not joined or is on its way out. */
  function currentMembership(): Membership | undefined {
    if (joinedSessionPath === undefined || membershipStopping) return undefined;
    return { sessionPath: joinedSessionPath, generation: membershipGeneration };
  }

  function isCurrentMembership(membership: Membership): boolean {
    return !membershipStopping && joinedSessionPath === membership.sessionPath && membershipGeneration === membership.generation;
  }

  /** The session joined the bridge and has a Slack client: it may post, react and upload without owning the socket. */
  function canPost(): boolean {
    return slackClient !== null && joinedSessionPath !== undefined;
  }

  /** This process is the router: it owns the lock and has the Slack socket open. */
  function isRouter(): boolean {
    return ownsBridgeConnection() && slackIsConnected();
  }

  /**
   * Chat id of the paired DM. The config file is authoritative: another process may have paired or
   * revoked since this one started. In-memory auth is only the fallback when nothing is stored.
   */
  function notificationChatId(): string | undefined {
    const stored = loadConfig().auth;
    if (!stored) return auth.getNotificationChatId();
    const trusted = stored.trustedUser?.split(":")[0];
    return trusted ? stored.userChats?.[trusted] : undefined;
  }

  function getSlackClient(): SlackClient | null {
    return slackClient;
  }

  /** Flip tool-call visibility in remote messages and describe the new state. */
  function toggleToolCalls(): string {
    const cfg = updateConfig((config) => {
      config.hideToolCalls = !config.hideToolCalls;
    });
    return `🔧 Tool calls ${cfg.hideToolCalls ? "hidden" : "shown"} in remote messages`;
  }

  /** Flip whether joined sessions auto-claim the router role, and describe the new state. */
  function toggleAutoConnect(): string {
    const cfg = updateConfig((config) => {
      config.autoConnect = config.autoConnect === false;
    });
    return `🔌 Auto-claim of the router role ${cfg.autoConnect !== false ? "on" : "off"}`;
  }

  /** Add or remove a session from the list that never auto-claims the router role. False when nothing changed. */
  function setOptedOut(sessionFile: string, optedOut: boolean): boolean {
    let changed = false;
    updateConfig((config) => {
      const current = config.optedOutSessions ?? [];
      if (current.includes(sessionFile) === optedOut) return;
      changed = true;
      const next = optedOut ? [...current, sessionFile] : current.filter((entry) => entry !== sessionFile);
      config.optedOutSessions = next.length > 0 ? next : undefined;
    });
    return changed;
  }

  function setSessionOptOut(
    ui: { notify(message: string, type: "info" | "warning" | "error"): void },
    optedOut: boolean,
  ): void {
    const sessionFile = getCurrentSessionFile();
    if (!sessionFile) {
      ui.notify("❌ No session file available for this session", "error");
      return;
    }
    if (!setOptedOut(sessionFile, optedOut)) {
      ui.notify(
        optedOut
          ? "ℹ️ This session is already opted out of auto-claiming the router role"
          : "ℹ️ This session was not opted out — nothing to do",
        "info",
      );
      return;
    }
    ui.notify(
      optedOut
        ? "🛑 This session will NOT auto-claim the Slack router role"
        : "✅ This session can auto-claim the Slack router role again",
      "info",
    );
  }

  function toPendingRemoteChat(message: ExternalMessage): PendingRemoteChat {
    return {
      chatId: message.chatId,
      username: message.username,
      messageId: message.messageId,
      threadId: message.threadId,
      isThreadReply: message.isThreadReply,
    };
  }

  /** Extract the final assistant response text from agent_end messages */
  function extractFinalResponseText(messages: Array<{ role: string; content?: any; stopReason?: string }>): string {
    const finalAssistant = messages
      .filter((m) => m.role === "assistant" && m.stopReason === "stop")
      .pop();
    if (!finalAssistant) return "";
    return extractTextFromMessage(finalAssistant as AssistantMessage);
  }

  /** Resolve a thread ID: prefer explicit, fall back to remembered */
  function resolveThreadId(chatId: string, explicitThreadId?: string): string | undefined {
    return explicitThreadId || getRememberedSlackThreadForCurrentSession(chatId, getCurrentSessionFile);
  }

  // ── Slack reaction helpers ───────────────────────────────────────────────

  async function clearSlackWorkingReaction(): Promise<void> {
    if (!activeSlackReaction) return;

    const reactionTarget = activeSlackReaction;
    activeSlackReaction = null;
    const slack = getSlackClient();
    if (!slack) return;

    try {
      await slack.removeReaction(reactionTarget.chatId, reactionTarget.messageId, "hourglass_flowing_sand");
    } catch {
      // Ignore cleanup failures
    }
  }

  async function setSlackWorkingReaction(remoteChat: PendingRemoteChat | null): Promise<void> {
    if (!remoteChat) {
      await clearSlackWorkingReaction();
      return;
    }

    if (
      activeSlackReaction &&
      activeSlackReaction.chatId === remoteChat.chatId &&
      activeSlackReaction.messageId === remoteChat.messageId
    ) {
      return;
    }

    await clearSlackWorkingReaction();
    const slack = getSlackClient();
    if (!slack) return;

    try {
      await slack.addReaction(remoteChat.chatId, remoteChat.messageId, "hourglass_flowing_sand");
      activeSlackReaction = {
        chatId: remoteChat.chatId,
        messageId: remoteChat.messageId,
      };
    } catch {
      // Ignore reaction failures so normal messaging still works
    }
  }

  // ── Send to Slack ────────────────────────────────────────────────────────

  async function sendToRemoteChat(
    chatId: string,
    text: string,
    options?: {
      threadId?: string;
      forceTopLevel?: boolean;
      rememberThreadForSessionPath?: string;
      noFooter?: boolean;
      onPosted?: (lastTs: string) => void;
    },
  ): Promise<string | undefined> {
    const slack = getSlackClient();
    if (!slack || !canPost()) return undefined;

    const threadTs = options?.forceTopLevel
      ? undefined
      : resolveThreadId(chatId, options?.threadId);
    const footerText = options?.noFooter ? undefined : await buildSlackFooterText(ctx);
    const rootThreadTs = await slack.sendMessageInThread(chatId, text, threadTs, footerText, options?.onPosted);
    if (rootThreadTs) {
      rememberSlackThreadForSession(chatId, rootThreadTs, options?.rememberThreadForSessionPath, getCurrentSessionFile);
    }
    return rootThreadTs;
  }

  async function sendRemoteText(message: ExternalMessage, text: string): Promise<void> {
    await sendToRemoteChat(message.chatId, text, {
      threadId: message.threadId,
    });
  }

  async function sendSlackFileToCurrentChat(
    filePathInput: string,
    options?: { title?: string; initialComment?: string },
    remoteChat: PendingRemoteChat | null = pendingRemoteChat,
  ): Promise<string> {
    if (!remoteChat || !canPost()) {
      throw new Error("No active remote chat is available for file upload");
    }


    const filePath = path.isAbsolute(filePathInput)
      ? filePathInput
      : path.join(ctx.cwd, filePathInput);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const threadId = resolveThreadId(remoteChat.chatId, remoteChat.threadId);
    if (threadId) {
      rememberSlackThreadForSession(remoteChat.chatId, threadId, undefined, getCurrentSessionFile);
    }

    if (!slackClient) {
      throw new Error("Slack client not available");
    }
    await slackClient.sendFile(remoteChat.chatId, filePath, {
      title: options?.title,
      initialComment: options?.initialComment,
      threadId,
    });

    return filePath;
  }

  // ── Replay / handover ────────────────────────────────────────────────────

  async function replayAllAssistantMessagesToSlackThread(remoteChat: PendingRemoteChat): Promise<void> {
    if (!remoteChat.threadId) {
      return;
    }

    if (hasLatestAssistantBeenDeliveredToSlackThread(
      remoteChat.chatId,
      remoteChat.threadId,
      undefined,
      getCurrentSessionFile,
      () => getLastAssistantMessageInfo(ctx.sessionManager),
    )) {
      return;
    }

    const conversation = getConversationHistory(ctx.sessionManager);
    if (conversation.length === 0) {
      return;
    }

    for (const entry of conversation) {
      const text = entry.role === "user"
        ? `🗣️ **User:** ${entry.text}`
        : entry.text;
      await sendToRemoteChat(remoteChat.chatId, text, {
        threadId: remoteChat.threadId,
      });
    }

    markLatestAssistantDeliveredToSlackThread(
      remoteChat.chatId,
      remoteChat.threadId,
      undefined,
      getCurrentSessionFile,
      () => getLastAssistantMessageInfo(ctx.sessionManager),
    );
  }

  // ── Bridge membership: join, leave, router election ──────────────────────
  //
  // Every Slack event reaches exactly one open socket, so exactly one process — the router, the
  // owner of the lock file — holds it. Every joined session can post to Slack with the bot token
  // alone. Replies the router receives for another live session's thread travel through that
  // session's inbox; there is no LLM relay anywhere on this path.

  type RouterRole = "this-session" | "other-session" | "none";

  interface JoinResult {
    /** Who holds the Slack socket once joining finished. */
    router: RouterRole;
    /** Why this session could not claim the router role, when it tried and failed. */
    error?: string;
  }

  /** Report from a background path without ever throwing: the host context may already be torn down. */
  function notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // The session context is gone.
    }
  }

  /** Like `notify`, but a failure that repeats on every tick is shown at most once a minute. */
  function notifyRepeating(key: string, message: string, level: "info" | "warning" | "error"): void {
    const now = Date.now();
    if ((lastNoticeAt.get(key) ?? 0) + NOTICE_REPEAT_MS > now) return;
    lastNoticeAt.set(key, now);
    notify(message, level);
  }

  /** Run a detached task whose failure must be reported rather than thrown: a stray rejection would take the host session down. */
  function runInBackground(task: () => Promise<void>): void {
    void task().catch((err: Error) => {
      notifyRepeating(`background:${err.message}`, `❌ slk-bridge background task failed: ${err.message}`, "error");
    });
  }

  function safeInterval(task: () => void | Promise<void>, ms: number): NodeJS.Timeout {
    const timer = setInterval(() => runInBackground(async () => task()), ms);
    timer.unref?.();
    return timer;
  }

  function routerRole(): RouterRole {
    const owner = getLockOwner();
    if (!owner) return "none";
    return owner.pid === process.pid && owner.owner === getInstanceId() ? "this-session" : "other-session";
  }

  function bridgeStatus(): BridgeStatus {
    const stats = auth.getStats();
    return {
      joined: isJoined(),
      router: routerRole(),
      socketOpen: slackIsConnected(),
      autoConnect: loadConfig().autoConnect !== false,
      trustedUser: stats.trustedUser,
      channels: stats.channels,
    };
  }

  function describeJoin(result: JoinResult): string {
    switch (result.router) {
      case "this-session":
        return "✅ Joined the Slack bridge. This session is the router.";
      case "other-session":
        return "✅ Joined the Slack bridge. Another session is the router.";
      case "none":
        return `⚠️ Joined the Slack bridge, but no session holds the Slack socket${
          result.error ? `: ${result.error}` : ". Run /slk-bridge router, or turn on /slk-bridge autoconnect."
        }`;
    }
  }

  /** One membership change at a time: join, leave and session switches never interleave. */
  function enqueueMembershipChange<T>(task: () => Promise<T>): Promise<T> {
    const run = membershipChange.then(task);
    membershipChange = run.then(() => undefined, () => undefined);
    return run;
  }

  function clearMembershipTimers(): void {
    for (const timer of membershipTimers) clearInterval(timer);
    membershipTimers = [];
  }

  /** Register the session and start the three periodic checks: lock ownership, router election, inbox. */
  function startMembership(sessionPath: string): void {
    registerSession(sessionPath);
    joinedSessionPath = sessionPath;
    membershipGeneration++;
    clearMembershipTimers();
    membershipTimers = [
      safeInterval(enforceLockOwnership, OWNERSHIP_CHECK_MS),
      safeInterval(electionTick, ELECTION_CHECK_MS),
      safeInterval(pollInbox, INBOX_POLL_MS),
    ];
    updateWidget();
  }

  function dropRouterLock(): void {
    if (!routerLockHeld) return;
    routerLockHeld = false;
    releaseLock();
  }

  /** Close the Slack socket and release the router lock. Time-capped so a shutdown stays inside the host's budget. */
  async function relinquishRouter(): Promise<void> {
    if (slackClient) await settleWithin(slackClient.disconnect(), SHUTDOWN_STEP_BUDGET_MS);
    dropRouterLock();
  }

  /**
   * Take this session out of the bridge: stop its checks, unregister it so the router stops handing
   * it messages, and give up the router role if held. The persisted join stays, so a restarted
   * process for the same session rejoins; `leaveCurrentSession` is the call that forgets it.
   */
  async function stopMembership(): Promise<void> {
    membershipGeneration++; // work queued for the membership that is ending must not run
    membershipStopping = true;
    try {
      clearMembershipTimers();
      if (joinedSessionPath) unregisterSession(joinedSessionPath);
      await Promise.all([
        relinquishRouter(),
        settleWithin(clearSlackWorkingReaction(), SHUTDOWN_STEP_BUDGET_MS),
      ]);
      joinedSessionPath = undefined;
      pendingRemoteChat = null;
      turnAccumulator = null;
      updateWidget();
    } finally {
      membershipStopping = false;
    }
  }

  /** Make the membership match the session this process hosts now (session start, switch, branch). */
  function reconcileMembership(): Promise<void> {
    return enqueueMembershipChange(async () => {
      const current = getCurrentSessionFile();
      if (current === joinedSessionPath) return;
      if (joinedSessionPath) await stopMembership();
      if (!slackClient || !current) return;
      if (loadConfig().joinedSessions?.includes(current)) {
        startMembership(current);
        runInBackground(electionTick);
      }
    }).catch((err: Error) => {
      notify(`❌ slk-bridge could not update its bridge membership: ${err.message}`, "error");
    });
  }

  /**
   * Join this session to the bridge: register it, remember the join so a restarted process rejoins,
   * post (or reuse) its root thread in the paired DM, and claim the router role. A live router is
   * never displaced unless `claim` is "force".
   */
  function joinCurrentSession(options: { postRoot: boolean; claim: "vacant" | "force" }): Promise<JoinResult> {
    return enqueueMembershipChange(async () => {
      if (!slackClient) throw new Error("Slack not configured. Run /slk-bridge configure first");
      const sessionPath = getCurrentSessionFile();
      if (!sessionPath) throw new Error("This session has no session file yet. Send a message first, then connect.");

      updateConfig((cfg) => {
        if (!cfg.joinedSessions?.includes(sessionPath)) cfg.joinedSessions = [...(cfg.joinedSessions ?? []), sessionPath];
      });
      if (joinedSessionPath === sessionPath) {
        registerSession(sessionPath);
      } else {
        if (joinedSessionPath) await stopMembership();
        startMembership(sessionPath);
      }

      if (options.postRoot) {
        const chatId = notificationChatId();
        if (chatId) await ensureSessionThread(chatId, sessionPath);
      }

      let error: string | undefined;
      try {
        await claimRouter({ force: options.claim === "force" });
      } catch (err) {
        error = (err as Error).message;
      }
      updateWidget();
      return { router: routerRole(), ...(error ? { error } : {}) };
    });
  }

  /** Leave the bridge for good: unlike a shutdown, this forgets the persisted join and drops pending messages. */
  function leaveCurrentSession(): Promise<void> {
    return enqueueMembershipChange(async () => {
      const sessionPath = joinedSessionPath ?? getCurrentSessionFile();
      if (sessionPath) {
        updateConfig((cfg) => {
          const remaining = (cfg.joinedSessions ?? []).filter((entry) => entry !== sessionPath);
          cfg.joinedSessions = remaining.length > 0 ? remaining : undefined;
        });
      }
      await stopMembership();
      if (sessionPath) clearInbox(sessionPath);
    });
  }

  // ── Router role ──────────────────────────────────────────────────────────

  /**
   * Take the router role: hold the lock, then open the Slack socket. `force` overwrites a live
   * router's lock (the old router notices and closes its socket); otherwise a live router is respected.
   * Resolves true when this session is the router afterwards.
   */
  async function claimRouter(options: { force: boolean }): Promise<boolean> {
    while (routerClaim) await routerClaim.catch(() => undefined); // one claim at a time
    const claim = doClaimRouter(options);
    routerClaim = claim;
    try {
      return await claim;
    } finally {
      if (routerClaim === claim) routerClaim = null;
    }
  }

  async function doClaimRouter(options: { force: boolean }): Promise<boolean> {
    const client = slackClient;
    const sessionPath = joinedSessionPath;
    if (!client || !sessionPath) return false;
    if (routerLockHeld && ownsBridgeConnection() && client.isConnected) return true;

    let tookOver = false;
    if (options.force) {
      const previous = forceAcquireLock();
      tookOver = !!previous && (previous.pid !== process.pid || previous.owner !== getInstanceId());
    } else if (!acquireLock()) {
      return false;
    }
    routerLockHeld = true;
    // The old router closes its socket within one ownership check of losing the lock.
    if (tookOver) await sleep(TAKEOVER_SETTLE_MS);

    try {
      // Trust may have changed in the previous router since this process started.
      const stored = loadConfig().auth;
      if (stored) auth.loadFromConfig(stored);
      await client.connect();
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      dropRouterLock();
      updateWidget();
      throw err;
    }

    // Left the bridge, or moved to another client or session, while connecting: undo.
    if (joinedSessionPath !== sessionPath || slackClient !== client) {
      await client.disconnect().catch(() => undefined);
      dropRouterLock();
      return false;
    }
    updateWidget();
    return true;
  }

  /** Joined sessions may claim a vacant router role on their own unless `autoConnect` is off or the session opted out. */
  function autoClaimAllowed(sessionPath: string): boolean {
    const config = loadConfig();
    return config.autoConnect !== false && !config.optedOutSessions?.includes(sessionPath);
  }

  /**
   * Every joined session runs this every couple of seconds: it notices a session switch no event
   * announced, keeps its registration alive, and claims the router role when no live process holds it.
   */
  async function electionTick(): Promise<void> {
    const sessionPath = joinedSessionPath;
    if (!sessionPath || !slackClient) return;
    const current = getCurrentSessionFile();
    if (current && current !== sessionPath) {
      await reconcileMembership();
      return;
    }
    ensureRegistered(sessionPath);

    if (routerClaim || isRouter()) return;
    const owner = getLockOwner();
    if (owner && !(owner.pid === process.pid && owner.owner === getInstanceId())) return; // a live router exists
    if (Date.now() < claimBackoff.notBefore || !autoClaimAllowed(sessionPath)) return;

    try {
      await claimRouter({ force: false });
      claimBackoff = { notBefore: 0, delayMs: 0 };
    } catch (err) {
      // Back off so a bad token or a dead network is not retried on every tick.
      const delayMs = Math.min(claimBackoff.delayMs ? claimBackoff.delayMs * 2 : ELECTION_CHECK_MS, MAX_CLAIM_BACKOFF_MS);
      claimBackoff = { notBefore: Date.now() + delayMs, delayMs };
      notifyRepeating("router-claim", `⚠️ Slack connection failed: ${(err as Error).message}`, "warning");
    }
  }

  /**
   * Close the Slack socket whenever this process no longer provably owns the router lock — taken
   * over by `/slk-bridge router`, or the local flag was cleared while the socket stayed open. Keying
   * on the socket as well as the flag is what stops a stray connection from outliving the lock.
   */
  async function enforceLockOwnership(): Promise<void> {
    const client = slackClient;
    if (!client || ownershipCheckInProgress) return;
    if (routerLockHeld && isLockHeldLocally() && isCurrentLockOwner()) return;
    if (!routerLockHeld && !client.isConnected) return;

    ownershipCheckInProgress = true;
    try {
      await client.disconnect();
      dropRouterLock();
      updateWidget();
      notify("🔄 slk-bridge router role moved to another session", "info");
    } finally {
      ownershipCheckInProgress = false;
    }
  }

  // ── Inbox ────────────────────────────────────────────────────────────────

  /** Hand every message the router queued for this session to the normal message path, oldest first and once each. */
  function pollInbox(): void {
    const membership = currentMembership();
    if (!membership) return;
    for (const message of drainInbox(membership.sessionPath)) {
      const key = `${message.chatId}:${message.messageId}`;
      if (seenInboxMessages.has(key)) continue;
      seenInboxMessages.add(key);
      if (seenInboxMessages.size > SEEN_INBOX_LIMIT) {
        const oldest = seenInboxMessages.values().next().value;
        if (oldest) seenInboxMessages.delete(oldest);
      }
      // The job keeps the membership it was read under, so leaving or switching sessions voids it
      // even though it is already queued (the queue itself cannot be emptied).
      inboxQueue = inboxQueue
        .then(() => handleIncomingRemoteMessage(message, { membership }))
        .catch((err: Error) => {
          notify(`❌ Failed to handle Slack message: ${err.message}`, "error");
        });
    }
  }

  async function startFreshBridgeSession(cwdArg?: string): Promise<string> {
    const cwd = resolvePathInput(cwdArg?.trim() ? cwdArg : ctx.cwd, ctx.cwd);
    const result = await runTmuxPiConnect({
      cwd,
      bridgeCommand: "/slk-bridge connect",
    });
    return buildTmuxConnectSummary(result);
  }

  async function resumeToListedBridgeSession(index: number): Promise<string> {
    const sessions = await listRecentSessions();
    const selected = sessions[index - 1];
    if (!selected) {
      throw new Error(`Session #${index} is not in the current recent-session list`);
    }

    const cwd = selected.cwd === "(unknown cwd)" ? ctx.cwd : selected.cwd;
    const result = await runTmuxPiConnect({
      cwd,
      piArgs: ["--session", selected.path],
      bridgeCommand: "/slk-bridge connect",
    });
    return buildTmuxConnectSummary(result);
  }

  // ── Message handling ─────────────────────────────────────────────────────

  async function forwardRemoteCommandToPi(message: ExternalMessage, text: string): Promise<void> {
    pendingRemoteChat = toPendingRemoteChat(message);

    if (message.threadId && !isExplicitRemoteResumeCommand(message.content)) {
      rememberSlackThreadForSession(message.chatId, message.threadId, undefined, getCurrentSessionFile);
    }
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  /**
   * Router entry point for every message that passed authorization. A thread reply belongs to the
   * session that owns the thread: a live owner receives it through its inbox, a dead one gets a
   * notice. Everything else (top-level, unmapped, this session's own threads, `.bridge resume`)
   * is handled here.
   */
  async function routeIncomingSlackMessage(message: ExternalMessage): Promise<void> {
    const route = decideInboundRoute(message, getCurrentSessionFile(), isSessionLive);
    switch (route.kind) {
      case "inbox":
        enqueueInboxMessage(route.sessionPath, message);
        return;
      case "offline":
        // The thread stays owned by its session; the notice is no reason to remap it to the router.
        await sendToRemoteChat(message.chatId, SESSION_OFFLINE_NOTICE, {
          threadId: message.threadId,
          rememberThreadForSessionPath: route.sessionPath,
          noFooter: true,
        });
        return;
      case "local": {
        // A router that is leaving the bridge must not feed its agent.
        const membership = currentMembership();
        if (membership) await handleIncomingRemoteMessage(message, { membership });
        return;
      }
    }
  }

  /**
   * Handle a Slack message addressed to this session, whether it arrived by socket or through the
   * inbox. `membership` pins the join the message was accepted under: inbox jobs are queued ahead of
   * time, and once the session has left or switched they are dropped instead of being fed to
   * whatever this process hosts by then.
   */
  async function handleIncomingRemoteMessage(
    message: ExternalMessage,
    options?: { replayLastAssistantMessage?: boolean; membership?: Membership },
  ): Promise<void> {
    const membership = options?.membership ?? currentMembership();
    const isStale = () => !membership || !isCurrentMembership(membership);
    if (isStale()) return;
    if (await questions.receive(message)) return;
    if (isStale()) return;

    if (message.threadId && !isExplicitRemoteResumeCommand(message.content)) {
      rememberSlackThreadForSession(message.chatId, message.threadId, undefined, getCurrentSessionFile);
    }

    if (options?.replayLastAssistantMessage) {
      await replayAllAssistantMessagesToSlackThread(toPendingRemoteChat(message));
      if (isStale()) return;
    }

    if (await handleRemoteCommand(message)) {
      return;
    }
    if (isStale()) return;

    const remoteChat = toPendingRemoteChat(message);
    pendingRemoteChat = remoteChat;
    await setSlackWorkingReaction(remoteChat);
    if (isStale()) {
      // Left while the reaction was being added: do not feed the agent, and take the reaction back.
      if (pendingRemoteChat === remoteChat) pendingRemoteChat = null;
      await clearSlackWorkingReaction();
      return;
    }
    const taggedMessage = `[📱 @${message.username} via Slack]: ${message.content}`;
    if (ctx.isIdle()) {
      pi.sendUserMessage(taggedMessage);
    } else {
      pi.sendUserMessage(taggedMessage, { deliverAs: "followUp" });
    }
  }

  // ── Remote command handler (Slack messages starting with . or / commands) ──

  async function handleRemoteCommand(message: ExternalMessage): Promise<boolean> {
    const trimmed = message.content.trim();
    const lowered = trimmed.toLowerCase();

    if (lowered === "stop") {
      if (ctx.isIdle()) {
        await sendRemoteText(message, "Nothing is currently running.");
      } else {
        await clearSlackWorkingReaction();
        pendingRemoteChat = null;
        ctx.abort();
        await sendRemoteText(message, "🛑 Stopped current response.");
      }
      return true;
    }

    if (trimmed === ".") {
      const commands = pi.getCommands();
      await sendRemoteText(message, buildRemoteCommandList(commands));
      return true;
    }

    if (trimmed.startsWith(".skill")) {
      const match = trimmed.match(/^\.skill\s+([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!match) {
        await sendRemoteText(message, "Usage: `.skill <name> [args]`");
        return true;
      }

      const skillName = match[1];
      const args = match[2]?.trim() ?? "";
      const commandName = `skill:${skillName}`;
      const command = pi.getCommands().find((item) => item.source === "skill" && item.name === commandName);
      if (!command) {
        await sendRemoteText(message, `Unknown skill: ${skillName}. Send \`.\` to list available commands.`);
        return true;
      }

      await forwardRemoteCommandToPi(message, `/${commandName}${args ? ` ${args}` : ""}`);
      return true;
    }

    if (trimmed.startsWith(".prompt")) {
      const match = trimmed.match(/^\.prompt\s+([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!match) {
        await sendRemoteText(message, "Usage: `.prompt <name> [args]`");
        return true;
      }

      const promptName = match[1];
      const args = match[2]?.trim() ?? "";
      const command = pi.getCommands().find((item) => item.source === "prompt" && item.name === promptName);
      if (!command) {
        await sendRemoteText(message, `Unknown prompt: ${promptName}. Send \`.\` to list available commands.`);
        return true;
      }

      await forwardRemoteCommandToPi(message, `/${promptName}${args ? ` ${args}` : ""}`);
      return true;
    }

    if (trimmed.startsWith(".bridge")) {
      const match = trimmed.match(/^\.bridge(?:\s+([^\s]+))?(?:\s+([\s\S]+))?$/);
      const subcommand = match?.[1]?.toLowerCase() ?? "help";
      const rest = match?.[2]?.trim() ?? "";

      switch (subcommand) {
        case "help":
          await sendRemoteText(message, buildBridgeHelpText());
          return true;
        case "status":
          await sendRemoteText(message, buildBridgeStatusText(bridgeStatus()));
          return true;
        case "connect":
          try {
            const result = await joinCurrentSession({ postRoot: true, claim: "vacant" });
            await sendRemoteText(message, describeJoin(result));
          } catch (err) {
            await sendRemoteText(message, `❌ Connection failed: ${(err as Error).message}`);
          }
          return true;
        case "disconnect":
          // Answer first: once this session has left the bridge it stays silent.
          await sendRemoteText(message, "🔌 Left the Slack bridge. Run /slk-bridge connect in this session to rejoin.");
          await leaveCurrentSession();
          return true;
        case "new":
          try {
            const summary = await startFreshBridgeSession(rest || undefined);
            await sendRemoteText(message, summary);
          } catch (err) {
            await sendRemoteText(message, `❌ Failed to start fresh bridge session: ${(err as Error).message}`);
          }
          return true;
        case "resume": {
          if (!rest) {
            await sendRemoteText(message, await buildSessionListText(10));
            return true;
          }
          if (/^list(?:\s|$)/i.test(rest)) {
            const limitArg = rest.replace(/^list\s*/i, "").trim();
            const limit = limitArg ? parseInt(limitArg, 10) : 10;
            if (!Number.isFinite(limit) || limit < 1) {
              await sendRemoteText(message, "Usage: `.bridge resume list [number]`");
              return true;
            }
            await sendRemoteText(message, await buildSessionListText(limit));
            return true;
          }
          const index = parseInt(rest, 10);
          if (!Number.isFinite(index) || index < 1) {
            await sendRemoteText(message, "Usage: `.bridge resume <number>` or `.bridge resume list [number]`");
            return true;
          }
          try {
            const summary = await resumeToListedBridgeSession(index);
            await sendRemoteText(message, summary);
          } catch (err) {
            await sendRemoteText(message, `❌ Failed to resume session: ${(err as Error).message}`);
          }
          return true;
        }
        case "sendfile":
          if (!rest) {
            await sendRemoteText(message, "Usage: `.bridge sendfile <path>`");
            return true;
          }
          try {
            const filePath = await sendSlackFileToCurrentChat(rest, undefined, toPendingRemoteChat(message));
            await sendRemoteText(message, `📎 Uploaded ${path.basename(filePath)} to current Slack chat`);
          } catch (err) {
            await sendRemoteText(message, `❌ File upload failed: ${(err as Error).message}`);
          }
          return true;
        case "replay": {
          const conversation = getConversationHistory(ctx.sessionManager);
          if (conversation.length === 0) {
            return true;
          }
          const threadTs = await sendToRemoteChat(message.chatId, "🔄 **Session Replay**", {
            threadId: message.threadId,
            forceTopLevel: !message.threadId,
          });
          if (!threadTs) {
            return true;
          }
          for (const entry of conversation) {
            const text = entry.role === "user"
              ? `🗣️ **User:** ${entry.text}`
              : entry.text;
            await sendToRemoteChat(message.chatId, text, { threadId: threadTs });
          }
          markLatestAssistantDeliveredToSlackThread(
            message.chatId,
            threadTs,
            undefined,
            getCurrentSessionFile,
            () => getLastAssistantMessageInfo(ctx.sessionManager),
          );
          return true;
        }
        case "toggletools":
          await sendRemoteText(message, toggleToolCalls());
          return true;
        default:
          await sendRemoteText(message, `Unknown bridge command: ${subcommand}`);
          return true;
      }
    }

    return false;
  }

  // ── Widget ───────────────────────────────────────────────────────────────

  function updateWidget(): void {
    try {
      const config = loadConfig();

      if (config.showWidget === false) {
        ctx.ui.setStatus("slk-bridge-status", undefined);
        return;
      }

      const statusText = createStatusWidget({ connected: isJoined(), router: isRouter() }, { slack: [] });
      ctx.ui.setStatus("slk-bridge-status", statusText || undefined);
    } catch {
      // The session context may already be torn down.
    }
  }

  function saveAuthState(): void {
    updateConfig((config) => {
      config.auth = auth.exportConfig();
    });
  }

  // ── Register tool ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "send_slack_file",
    label: "Send Slack File",
    description: "Upload a local file to the current Slack conversation",
    promptSnippet: "Upload a local file to the active Slack chat",
    promptGuidelines: [
      "Use send_slack_file when the user explicitly asks to receive a file in Slack and the file already exists locally.",
      "Prefer normal text replies unless the user asked for a file or the content is better delivered as a file.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local file to upload" }),
      title: Type.Optional(Type.String({ description: "Optional title shown in Slack" })),
      initialComment: Type.Optional(Type.String({ description: "Optional comment to post with the file" })),
    }),
    async execute(_toolCallId, params) {
      const filePath = await sendSlackFileToCurrentChat(params.path, {
        title: params.title,
        initialComment: params.initialComment,
      });

      return {
        content: [{ type: "text", text: `Uploaded ${path.basename(filePath)} to the current Slack chat.` }],
        details: {
          chatId: pendingRemoteChat?.chatId,
          path: filePath,
        },
      };
    },
  });

  // ── Slack client wiring ──────────────────────────────────────────────────

  /**
   * Inbound path of the router: whichever process holds the socket routes what it receives. There
   * is deliberately no router-lock check here — a socket that is still open must not drop events
   * while ownership is moving; the ownership timer closes it.
   */
  function wireSlackClient(client: SlackClient): void {
    client.onMessage((msg: ExternalMessage) => {
      void routeIncomingSlackMessage(msg).catch((err: Error) => {
        notify(`❌ Failed to handle Slack message: ${err.message}`, "error");
      });
    });

    client.onError((err: Error) => {
      notify(`❌ Slack error: ${err.message}`, "error");
    });
  }

  /** Disconnect the previous client before a new one takes its place so no socket is orphaned. */
  async function replaceSlackClient(next: SlackClient | null): Promise<void> {
    const previous = slackClient;
    slackClient = next;
    if (next) wireSlackClient(next);
    if (previous) await previous.disconnect().catch(() => undefined);
  }

  /** Rebuild the Slack client from `slack` (or the stored config) and join this session. */
  async function reconnectSlack(slack?: { botToken: string; appToken: string }): Promise<JoinResult> {
    const tokens = slack ?? loadConfig().slack;
    if (!tokens?.botToken || !tokens.appToken) {
      throw new Error("Slack not configured. Run /slk-bridge configure first");
    }
    await replaceSlackClient(new SlackClient(tokens, auth));
    return joinCurrentSession({ postRoot: true, claim: "vacant" });
  }

  // ── pi lifecycle hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    // A re-fired start must not leave the previous membership (timers, registration, socket) behind.
    await stopMembership();

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        notify(`🔐 Challenge code for @${username}: ${code}`, "info");
      },
      (message, level) => {
        notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the Slack client's sendMessage
      },
      saveAuthState,
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Every session with tokens gets a client: posting needs only the bot token. The socket opens
    // later, and only in the router.
    await replaceSlackClient(
      config.slack?.botToken && config.slack?.appToken ? new SlackClient(config.slack, auth) : null,
    );

    // Rejoin a session that joined before. Non-blocking by design: session_start is awaited by the
    // host, and the router claim (jiti-transpiling @slack/bolt + auth.test() + Socket Mode start)
    // runs from the election tick, never from here.
    await reconcileMembership();
    updateWidget();
  });

  // OMP rebinds the live session in place and reports it with these events; upstream Pi tears the
  // runtime down and fires session_start again instead. Either way membership follows the session file.
  const ompSessionEvents = pi as unknown as {
    on(
      event: "session_switch" | "session_branch",
      handler: (event: unknown, context: ExtensionContext) => Promise<void>,
    ): void;
  };
  for (const eventName of ["session_switch", "session_branch"] as const) {
    ompSessionEvents.on(eventName, async (_event, context) => {
      ctx = context;
      await reconcileMembership();
      updateWidget();
    });
  }

  pi.on("message_end", async (event, context) => {
    if (pendingRemoteChat || handoverPending || !canPost()) return;
    ctx = context;
    const chatId = notificationChatId();
    if (!chatId) return;
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop") return;
    const text = extractTextFromMessage(message);
    if (!text) return;
    // A joined session owns a thread; create its root now if joining could not post one.
    const sessionPath = getCurrentSessionFile();
    const threadId = resolveThreadId(chatId)
      ?? (sessionPath ? await ensureSessionThread(chatId, sessionPath) : undefined);
    if (threadId) await sendToRemoteChat(chatId, text, { threadId, noFooter: true });
  });

  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat && canPost()) {
      try {
        await setSlackWorkingReaction(pendingRemoteChat);
      } catch {
        // Ignore reaction errors
      }
    }
  });

  /**
   * turn_end → accumulate response text into a buffer.
   *
   * Strategy: instead of sending each turn incrementally to Slack (which creates
   * many small messages), we buffer all turns and flush them as one batch on
   * agent_end. This gives cleaner Slack output.
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat || !canPost()) {
      if (!canPost()) {
        pendingRemoteChat = null;
      }
      return;
    }

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const config = loadConfig();

      const parts: string[] = [];
      const trimmedResponse = responseText.trim();
      if (trimmedResponse) parts.push(trimmedResponse);
      if (toolCallsText && !config.hideToolCalls) parts.push(toolCallsText);

      if (parts.length === 0) {
        return;
      }

      if (!turnAccumulator) {
        turnAccumulator = {
          chatId: pendingRemoteChat.chatId,
          entries: [],
          threadId: pendingRemoteChat.threadId,
        };
      }

      turnAccumulator.entries.push(parts.join("\n\n"));
    } catch (err) {
      ctx.ui.notify(`Failed to accumulate turn response: ${(err as Error).message}`, "error");
    }
  });

  /**
   * agent_end → handle both Slack-originated message flush and terminal handover.
   *
   * Two independent branches:
   * 1. Slack-originated message: flush accumulated turns to the existing Slack thread
   * 2. Terminal handover: send conversation history + final response to a new Slack thread
   */
  pi.on("agent_end", async (event, _context) => {
    // Branch 1: Message originated from Slack — flush accumulated turns
    if (pendingRemoteChat && canPost()) {
      try {
        const totalEntries = turnAccumulator?.entries.length ?? 0;
        let lastSlackThreadId = turnAccumulator?.threadId;

        for (let ei = 0; ei < totalEntries; ei++) {
          const isLast = ei === totalEntries - 1;
          const entry = turnAccumulator!.entries[ei];
          const resolvedThreadId = await sendToRemoteChat(
            turnAccumulator!.chatId,
            entry,
            {
              threadId: turnAccumulator!.threadId,
              noFooter: !isLast,
            },
          );
          if (resolvedThreadId) {
            lastSlackThreadId = resolvedThreadId;
          }
        }

        if (lastSlackThreadId) {
          markLatestAssistantDeliveredToSlackThread(
            turnAccumulator!.chatId,
            lastSlackThreadId,
            undefined,
            getCurrentSessionFile,
            () => getLastAssistantMessageInfo(ctx.sessionManager),
          );
        }
      } catch (err) {
        ctx.ui.notify(`Failed to send accumulated response: ${(err as Error).message}`, "error");
      }
      await clearSlackWorkingReaction();
    }

    // Branch 2: Terminal handover — send history + final response to Slack
    if (handoverPending) {
      const handoverChatId = handoverPending.chatId;
      const conversation = getConversationHistory(ctx.sessionManager);
      const finalResponse = extractFinalResponseText(event.messages);

      if (conversation.length > 0 || finalResponse) {
        const threadTs = await sendToRemoteChat(handoverChatId, "🔄 Terminal session pushed to Slack", {
          forceTopLevel: true,
        });
        if (threadTs) {
          // Background the history + final response replay so agent_end returns
          // quickly — pi can process the user's next Slack message without waiting
          // for dozens of sequential Slack API calls. The thread is already remembered via the
          // awaited header send above.
          void (async () => {
            try {
              for (const entry of conversation) {
                const text = entry.role === "user"
                  ? `\u{1F5E3}\uFE0F **User:** ${entry.text}`
                  : entry.text;
                await sendToRemoteChat(handoverChatId, text, { threadId: threadTs });
              }
              if (finalResponse) {
                // getConversationHistory already includes the final assistant message
                // (it collects completed assistant turns). Only post finalResponse
                // separately when it is NOT already the last pushed message —
                // otherwise the final message would be delivered twice.
                const lastAssistantInConversation = [...conversation].reverse().find((e) => e.role === "assistant");
                const alreadyPushed = lastAssistantInConversation && lastAssistantInConversation.text === finalResponse;
                if (!alreadyPushed) {
                  await sendToRemoteChat(handoverChatId, finalResponse, { threadId: threadTs });
                }
              }
              markLatestAssistantDeliveredToSlackThread(
                handoverChatId,
                threadTs,
                undefined,
                getCurrentSessionFile,
                () => getLastAssistantMessageInfo(ctx.sessionManager),
              );
            } catch {
              // Ignore handover push failures
            }
          })();
        }
      }
      handoverPending.resolve();
      handoverPending = null;
    }

    // Common state cleanup
    pendingRemoteChat = null;
    turnAccumulator = null;
  });

  pi.on("session_shutdown", async (_event, _context) => {
    // Hosts give shutdown handlers about two seconds: stopMembership caps every network step so the
    // router lock and the registration are always released in time. The persisted join stays, so a
    // restarted process for the same session rejoins.
    await stopMembership();
  });

  // ── /slk-bridge command (TUI local) ────────────────────────────────────────

  pi.registerCommand("slk-bridge", {
    description: "Manage the Slack bridge (help|status|connect|disconnect|router|configure|widget|new|resume)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
      const subcommand = parts[0] || "";

      // No subcommand → open interactive menu
      if (!subcommand || subcommand === "menu") {
        await openMainMenu({
          ui: context.ui,
          reconnect: async () => {
            await reconnectSlack();
          },
          disconnect: leaveCurrentSession,
          toggleToolCalls: () => {
            context.ui.notify(toggleToolCalls(), "info");
          },
          toggleAutoConnect: () => {
            context.ui.notify(toggleAutoConnect(), "info");
          },
          optOut: () => setSessionOptOut(context.ui, true),
          optIn: () => setSessionOptOut(context.ui, false),
          getStatusLine: () => {
            const status = bridgeStatus();
            const router = status.router === "this-session"
              ? "this session"
              : status.router === "other-session" ? "another session" : "none";
            return [
              `  ${status.joined ? "● Joined" : "○ Not joined"}`,
              `  Router: ${router}`,
              `  Trusted user: ${status.trustedUser ?? "None"}`,
              `  Auto-claim router: ${status.autoConnect ? "on" : "off"}`,
            ].join("\n");
          },
        });
        return;
      }

      switch (subcommand) {
        case "help":
          context.ui.notify(buildBridgeHelpText(), "info");
          break;

        case "status":
          context.ui.notify(buildBridgeStatusText(bridgeStatus()), "info");
          break;

        case "connect": {
          try {
            const result = await joinCurrentSession({ postRoot: true, claim: "vacant" });
            context.ui.notify(describeJoin(result), result.router === "none" ? "warning" : "info");
          } catch (err) {
            context.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "disconnect": {
          await leaveCurrentSession();
          context.ui.notify("🔌 Left the Slack bridge", "info");
          break;
        }

        case "router": {
          try {
            const result = await joinCurrentSession({ postRoot: true, claim: "force" });
            const tookRouter = result.router === "this-session";
            context.ui.notify(
              tookRouter
                ? "✅ This session is now the Slack router"
                : `❌ Could not take the router role${result.error ? `: ${result.error}` : ""}`,
              tookRouter ? "info" : "error",
            );
          } catch (err) {
            context.ui.notify(`❌ Could not take the router role: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "configure": {
          const botToken = parts[1];
          const appToken = parts[2];

          if (!botToken || !appToken) {
            context.ui.notify("Usage: /slk-bridge configure <bot-token> <app-token>", "error");
            return;
          }

          updateConfig((config) => {
            config.slack = { botToken, appToken };
          });

          try {
            const result = await reconnectSlack({ botToken, appToken });
            context.ui.notify(`Slack configured. ${describeJoin(result)}`, result.router === "none" ? "warning" : "info");
          } catch (err) {
            context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
          }
          updateWidget();
          break;
        }

        case "widget": {
          const cfg = updateConfig((config) => {
            config.showWidget = config.showWidget === false;
          });
          const widgetState = cfg.showWidget !== false ? "shown" : "hidden";
          context.ui.notify(`📊 Status widget ${widgetState}`, "info");
          updateWidget();
          break;
        }

        case "new": {
          const cwdArg = parts.slice(1).join(" ").trim();
          try {
            const summary = await startFreshBridgeSession(cwdArg || undefined);
            context.ui.notify(summary, "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to start fresh bridge session: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "resume": {
          const rest = parts.slice(1).join(" ").trim();
          if (!rest) {
            context.ui.notify(await buildSessionListText(10), "info");
            break;
          }
          if (/^list(?:\s|$)/i.test(rest)) {
            const limitArg = rest.replace(/^list\s*/i, "").trim();
            const limit = limitArg ? parseInt(limitArg, 10) : 10;
            if (!Number.isFinite(limit) || limit < 1) {
              context.ui.notify("Usage: /slk-bridge resume list [number]", "error");
              break;
            }
            try {
              context.ui.notify(await buildSessionListText(limit), "info");
            } catch (err) {
              context.ui.notify(`❌ Failed to list sessions: ${(err as Error).message}`, "error");
            }
            break;
          }
          const index = parseInt(rest, 10);
          if (!Number.isFinite(index) || index < 1) {
            context.ui.notify("Usage: /slk-bridge resume <number> or /slk-bridge resume list [number]", "error");
            break;
          }
          try {
            const summary = await resumeToListedBridgeSession(index);
            context.ui.notify(summary, "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to resume session: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "sendfile": {
          const fileArg = parts.slice(1).join(" ").trim();
          if (!fileArg) {
            context.ui.notify("Usage: /slk-bridge sendfile <path>", "error");
            break;
          }
          try {
            const filePath = await sendSlackFileToCurrentChat(fileArg);
            context.ui.notify(`📎 Uploaded ${path.basename(filePath)} to current Slack chat`, "info");
          } catch (err) {
            context.ui.notify(`❌ File upload failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "releaseclaim": {
          // Another process may have changed trust since this one started; release from the current state.
          const stored = loadConfig().auth;
          if (stored) auth.loadFromConfig(stored);
          const removed = auth.releaseClaim();
          context.ui.notify(
            `🔓 Re-opened Slack claim${removed > 0 ? ` (removed ${removed} trusted user${removed === 1 ? "" : "s"})` : ""}`,
            "info",
          );
          break;
        }

        case "optout":
        case "opt-out":
          setSessionOptOut(context.ui, true);
          break;

        case "optin":
        case "opt-in":
          setSessionOptOut(context.ui, false);
          break;

        case "optout-list":
        case "optout list":
        case "opt-out-list":
        case "opt-out list": {
          const cfg = loadConfig();
          const optedOut = cfg.optedOutSessions ?? [];
          if (optedOut.length === 0) {
            context.ui.notify("📋 No sessions are opted out of auto-claiming the router role", "info");
            break;
          }
          const lines = ["📋 Sessions that never auto-claim the router role", ""];
          for (const s of optedOut) {
            lines.push(`  • ${s}`);
          }
          context.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "toggletools":
          context.ui.notify(toggleToolCalls(), "info");
          break;

        case "autoconnect":
          context.ui.notify(toggleAutoConnect(), "info");
          break;

        case "handover": {
          // Preamble: opt in if needed, join the bridge if needed
          const sessionFile = getCurrentSessionFile();
          if (sessionFile && setOptedOut(sessionFile, false)) {
            context.ui.notify("ℹ️ Session auto-opted in for handover", "info");
          }

          if (!hasConfiguredSlack()) {
            context.ui.notify("❌ Slack not configured. Run /slk-bridge configure first", "error");
            break;
          }

          // The handover itself opens this session's thread, so joining posts no separate root.
          try {
            const wasJoined = isJoined();
            await joinCurrentSession({ postRoot: false, claim: "vacant" });
            if (!wasJoined) context.ui.notify("✅ Joined the Slack bridge for handover", "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to join the Slack bridge: ${(err as Error).message}`, "error");
            break;
          }

          // Get trusted user's DM chatId
          const handoverChatId = notificationChatId();
          if (!handoverChatId) {
            context.ui.notify("❌ No trusted user found. Authenticate a user first.", "error");
            break;
          }

          if (context.isIdle()) {
            // Idle: send history immediately
            const conversation = getConversationHistory(ctx.sessionManager);
            if (conversation.length === 0) {
              context.ui.notify("ℹ️ No conversation history to push", "info");
              break;
            }

            const threadTs = await sendToRemoteChat(handoverChatId, "🔄 Terminal session pushed to Slack", {
              forceTopLevel: true,
            });
            if (!threadTs) {
              context.ui.notify("❌ Failed to create Slack thread", "error");
              break;
            }
            for (const entry of conversation) {
              const text = entry.role === "user"
                ? `\u{1F5E3}\uFE0F **User:** ${entry.text}`
                : entry.text;
              await sendToRemoteChat(handoverChatId, text, { threadId: threadTs });
            }
            markLatestAssistantDeliveredToSlackThread(
              handoverChatId,
              threadTs,
              undefined,
              getCurrentSessionFile,
              () => getLastAssistantMessageInfo(ctx.sessionManager),
            );
            context.ui.notify("✅ Session pushed to Slack", "info");
          } else {
            // Busy: wait for agent_end
            let resolveHandover: (() => void) | null = null;
            const handoverPromise = new Promise<void>((resolve) => {
              resolveHandover = resolve;
            });
            handoverPending = {
              chatId: handoverChatId,
              resolve: resolveHandover!,
              reject: (_err: Error) => { /* reject won't happen in normal flow */ },
            };
            context.ui.notify("⏳ Waiting for agent to finish...", "info");
            await handoverPromise;
            context.ui.notify("✅ Session pushed to Slack", "info");
          }
          break;
        }

        case "accept-handoff": {
          const handoffFile = parts.slice(1).join(" ").trim();
          if (!handoffFile) {
            context.ui.notify("Usage: /slk-bridge accept-handoff <file>", "error");
            break;
          }

          try {
            const raw = fs.readFileSync(handoffFile, "utf-8");
            const payload = JSON.parse(raw) as {
              message: Omit<ExternalMessage, "timestamp"> & { timestamp: string };
              replayLastAssistantMessage?: boolean;
            };
            const message: ExternalMessage = {
              ...payload.message,
              timestamp: new Date(payload.message.timestamp),
            };

            await joinCurrentSession({ postRoot: false, claim: "vacant" });
            await handleIncomingRemoteMessage(message, {
              replayLastAssistantMessage: payload.replayLastAssistantMessage === true,
            });
          } catch (err) {
            context.ui.notify(`❌ Failed to accept slk-bridge handoff: ${(err as Error).message}`, "error");
          } finally {
            try {
              fs.unlinkSync(handoffFile);
            } catch {
              // Ignore cleanup failures
            }
          }
          break;
        }

        default:
          context.ui.notify(`Unknown subcommand: ${subcommand}. Run /slk-bridge help`, "warning");
          break;
      }
    },
  });
}
