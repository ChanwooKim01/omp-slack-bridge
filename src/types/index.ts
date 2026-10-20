/**
 * Shared type definitions for the Slack bridge extension.
 */

/**
 * External message received from Slack.
 */
export interface ExternalMessage {
  /** Slack channel ID */
  chatId: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender Slack user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Slack message timestamp (ts) */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
  /** Slack thread_ts when replying inside a thread */
  threadId?: string;
  /** Whether the incoming message was sent as a reply inside an existing thread */
  isThreadReply?: boolean;
}

/**
 * Title and summary of a session thread whose history is kept short, stored per thread
 * (`slackRouting.threadMeta["chat:threadTs"]`).
 */
export interface SlackThreadMeta {
  /** Shown first in the thread's header; defaults to the first line of the root message. */
  title?: string;
  /** Agent-written summary of the interactions that were pruned from the thread. */
  summary?: string;
  /**
   * Slack ts of the bot message that carries the header when the thread root is a user message
   * (a bot cannot edit a user's message). Unset when the root itself is the header.
   */
  summaryTs?: string;
  updatedAt: string;
}

/**
 * Slack bridge configuration.
 */
export interface SlackBridgeConfig {
  slack?: {
    botToken: string;
    appToken: string;
    /**
     * Optional user token (xoxp-, user scope chat:write) of the trusted Slack user. It is read by
     * exactly one module, slack/guarded-delete.ts, which uses it to delete that user's own messages
     * from one of this bridge's session threads in the paired DM, and for nothing else.
     */
    userToken?: string;
  };
  auth?: {
    trustedUser?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
    userChats?: Record<string, string>;
    claimOpen?: boolean;
  };
  slackRouting?: {
    threadsByKey?: Record<string, { sessionPath: string; updatedAt: string }>;
    activeThreadBySessionChat?: Record<string, { threadTs: string; updatedAt: string }>;
    lastAssistantDeliveryByThread?: Record<string, { sessionPath: string; assistantEntryId: string; updatedAt: string }>;
    threadMeta?: Record<string, SlackThreadMeta>;
  };
  hideToolCalls?: boolean;
  /**
   * Whether joined sessions claim the router role (the single Slack socket) on their own when no
   * live router exists. Default on. Joining and leaving never touch this flag.
   */
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
  /** Session file paths that never auto-claim the router role, even when `autoConnect` is on. */
  optedOutSessions?: string[];
  /** Session file paths joined to the Slack bridge; a restarted process for the same session rejoins on start. */
  joinedSessions?: string[];
  /** Newest interactions kept in a session thread when it is pruned (default 5, 1..50). */
  threadKeep?: number;
  /** A session thread is pruned once it holds this many interactions (default 10; must exceed `threadKeep`). */
  threadPruneAt?: number;
}

/**
 * Pending remote chat session tracking.
 */
export interface PendingRemoteChat {
  chatId: string;
  username: string;
  messageId: string;
  threadId?: string;
  isThreadReply?: boolean;
}

/**
 * Slack connection status.
 */
export interface ConnectionStatus {
  connected: boolean;
  error?: string;
}
