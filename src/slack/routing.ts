/**
 * routing.ts — Slack thread-to-session routing state.
 *
 * Manages the mapping between Slack threads and pi session files,
 * so incoming thread replies can be routed to the correct session.
 */

import { loadConfig, updateConfig } from "../config/index.js";
import type { ExternalMessage, SlackBridgeConfig } from "../types/index.js";

// ── Key helpers ────────────────────────────────────────────────────────────

export function getSlackThreadKey(chatId: string, threadTs: string): string {
  return `${chatId}:${threadTs}`;
}

export function getSlackSessionChatKey(sessionPath: string, chatId: string): string {
  return `${sessionPath}:${chatId}`;
}

// ── State accessors ────────────────────────────────────────────────────────

/** Read-only view of the persisted routing maps; writes go through `updateConfig` mutators below. */
export function getSlackRoutingState() {
  const routing = loadConfig().slackRouting;
  return {
    threadsByKey: routing?.threadsByKey ?? {},
    activeThreadBySessionChat: routing?.activeThreadBySessionChat ?? {},
    lastAssistantDeliveryByThread: routing?.lastAssistantDeliveryByThread ?? {},
  };
}

/** The routing section of the freshly re-read config, created on demand inside an `updateConfig` mutator. */
function routingSection(config: SlackBridgeConfig) {
  config.slackRouting ??= {};
  const routing = config.slackRouting;
  routing.threadsByKey ??= {};
  routing.activeThreadBySessionChat ??= {};
  routing.lastAssistantDeliveryByThread ??= {};
  return {
    threadsByKey: routing.threadsByKey,
    activeThreadBySessionChat: routing.activeThreadBySessionChat,
    lastAssistantDeliveryByThread: routing.lastAssistantDeliveryByThread,
  };
}

// ── Mutations ──────────────────────────────────────────────────────────────

export function rememberSlackThreadForSession(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
): void {
  if (!threadTs) return;

  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  if (!resolvedSessionPath) return;

  const updatedAt = new Date().toISOString();
  updateConfig((config) => {
    const { threadsByKey, activeThreadBySessionChat } = routingSection(config);
    threadsByKey[getSlackThreadKey(chatId, threadTs)] = {
      sessionPath: resolvedSessionPath,
      updatedAt,
    };
    activeThreadBySessionChat[getSlackSessionChatKey(resolvedSessionPath, chatId)] = {
      threadTs,
      updatedAt,
    };
  });
}

export function markLatestAssistantDeliveredToSlackThread(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
  getLastAssistantMessageInfo?: () => { entryId: string; text: string } | null,
): void {
  if (!threadTs) return;

  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  const lastAssistantMessage = getLastAssistantMessageInfo?.();
  if (!resolvedSessionPath || !lastAssistantMessage) return;

  const updatedAt = new Date().toISOString();
  updateConfig((config) => {
    const { lastAssistantDeliveryByThread } = routingSection(config);
    lastAssistantDeliveryByThread[getSlackThreadKey(chatId, threadTs)] = {
      sessionPath: resolvedSessionPath,
      assistantEntryId: lastAssistantMessage.entryId,
      updatedAt,
    };
  });
}

export function hasLatestAssistantBeenDeliveredToSlackThread(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
  getLastAssistantMessageInfo?: () => { entryId: string; text: string } | null,
): boolean {
  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  const lastAssistantMessage = getLastAssistantMessageInfo?.();
  if (!resolvedSessionPath || !lastAssistantMessage) return false;

  const { lastAssistantDeliveryByThread } = getSlackRoutingState();
  const record = lastAssistantDeliveryByThread[getSlackThreadKey(chatId, threadTs)];
  return record?.sessionPath === resolvedSessionPath && record?.assistantEntryId === lastAssistantMessage.entryId;
}

export function getSlackThreadOwnerSession(chatId: string, threadTs?: string): string | undefined {
  if (!threadTs) return undefined;
  const { threadsByKey } = getSlackRoutingState();
  return threadsByKey[getSlackThreadKey(chatId, threadTs)]?.sessionPath;
}

export function getRememberedSlackThreadForCurrentSession(
  chatId: string,
  getCurrentSessionFile?: () => string | undefined,
): string | undefined {
  // Always read the persisted per-session mapping: a process-wide cache keyed by chat leaked
  // one session's thread into the next session after /new, /resume, or a branch.
  const sessionPath = getCurrentSessionFile?.();
  if (!sessionPath) return undefined;
  return getSlackRoutingState().activeThreadBySessionChat[getSlackSessionChatKey(sessionPath, chatId)]?.threadTs;
}

// ── Inbound routing ────────────────────────────────────────────────────────

/** Posted into a thread whose owning session has no live process. */
export const SESSION_OFFLINE_NOTICE = "이 스레드의 세션이 꺼져 있습니다. Paseo에서 해당 에이전트를 열면 다시 연결됩니다.";

/** `.bridge resume` acts on the process that receives it, whichever session owns the thread. */
export function isExplicitRemoteResumeCommand(content: string): boolean {
  return /^\.bridge\s+resume(?:\s|$)/i.test(content.trim());
}

export type InboundRoute =
  /** Handle in the receiving (router) session. */
  | { kind: "local" }
  /** Another live session owns the thread: hand the message to its inbox. */
  | { kind: "inbox"; sessionPath: string }
  /** The owning session is not running: tell the user instead of guessing. */
  | { kind: "offline"; sessionPath: string };

/**
 * Decide where a message the router just received must be handled. Only a thread reply in a
 * thread owned by a different session leaves the router: top-level and unmapped messages, the
 * router's own threads, and explicit resume commands stay local.
 */
export function decideInboundRoute(
  message: Pick<ExternalMessage, "chatId" | "content" | "threadId" | "isThreadReply">,
  currentSessionPath: string | undefined,
  isSessionLive: (sessionPath: string) => boolean,
): InboundRoute {
  if (!message.threadId || !message.isThreadReply) return { kind: "local" };
  if (isExplicitRemoteResumeCommand(message.content)) return { kind: "local" };

  const ownerSessionPath = getSlackThreadOwnerSession(message.chatId, message.threadId);
  if (!ownerSessionPath || ownerSessionPath === currentSessionPath) return { kind: "local" };

  return isSessionLive(ownerSessionPath)
    ? { kind: "inbox", sessionPath: ownerSessionPath }
    : { kind: "offline", sessionPath: ownerSessionPath };
}
